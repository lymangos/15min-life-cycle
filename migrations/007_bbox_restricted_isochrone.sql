-- ============================================================
-- v3：等时圈性能重构
--
-- 起初以为瓶颈在 pgr_drivingDistance 传了全表 ways。实测推翻了这个判断：
--
--   find_nearest_node          28 ms
--   pgr_drivingDistance        18 ms   ← 16287 条边对 pgRouting 是小图
--   收集凸包点                 16 ms
--   ST_ConcaveHull(pts, 0.5)  5975 ms  ← 99% 的时间在这
--
-- 真正的瓶颈是 ST_ConcaveHull 的 pctconvex 参数。它的代价随该值下降急剧
-- 上升，而在本数据集上换来的形状收益很小：
--
--   pctconvex   耗时      面积km2   顶点数
--   0.50       5975 ms    2.546     3202
--   0.70       1138 ms    2.547     1060
--   0.75         91 ms    2.570      295   ← 拐点
--   0.90         44 ms    2.629      149
--
-- 取 0.75：比原来快约 65 倍，面积只差 0.9%，仍保留 295 个顶点的轮廓细节。
-- 三个阈值合计从 ~18 秒降到 ~0.3 秒。
--
-- 另外三处改动，收益比上面小但都是实打实的：
--
-- 1. bbox 限定边集。15 分钟步行按 5km/h 最远 1250m，只需原点周围约 1.5km
--    的边。网络距离必然 >= 直线距离，所以以最大步行距离为半径的圆是可达
--    节点集的严格超集，不会漏解；1.2 的余量留给「一端在圈内另一端在圈外」
--    的长边。路网分析从 ~80ms 降到 ~18ms，更重要的是限住了内存峰值。
-- 2. 临时表加主键。原实现的 EXISTS 子查询查的是无索引临时表，退化成全扫。
-- 3. 三个阈值原本各扫一遍 ways（共 9 次全表扫），改成一次扫描标注成本、
--    按阈值分组复用。
--
-- ⚠️ 别把 pctconvex 调回 0.5：这台机器 320MB 的 Postgres 内存限额下，
--    ST_Union 类的替代方案（缓冲区合并）实测会直接 OOM。
-- ============================================================

DROP FUNCTION IF EXISTS calculate_isochrones_optimized(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER[], DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION calculate_isochrones_optimized(
    p_lng DOUBLE PRECISION,
    p_lat DOUBLE PRECISION,
    p_time_thresholds INTEGER[] DEFAULT ARRAY[5, 10, 15],
    p_walk_speed_kmh DOUBLE PRECISION DEFAULT 5.0
)
RETURNS TABLE (
    minutes INTEGER,
    distance_m DOUBLE PRECISION,
    geom GEOMETRY,
    geojson TEXT
) AS $$
DECLARE
    v_source_id   BIGINT;
    v_max_cost    DOUBLE PRECISION;
    v_origin      GEOMETRY;
    v_threshold   INTEGER;
    v_result      GEOMETRY;
    v_collected   GEOMETRY;
    v_cnt         INTEGER;
    v_m_per_min   DOUBLE PRECISION;
    v_radius_m    DOUBLE PRECISION;
    v_dx          DOUBLE PRECISION;
    v_dy          DOUBLE PRECISION;
    v_edge_sql    TEXT;
BEGIN
    v_origin    := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
    v_m_per_min := p_walk_speed_kmh * 1000.0 / 60.0;

    v_source_id := find_nearest_node(p_lng, p_lat);

    -- 找不到路网节点时退化为圆形缓冲区（与原实现一致）
    IF v_source_id IS NULL THEN
        FOREACH v_threshold IN ARRAY p_time_thresholds LOOP
            v_result := ST_Transform(
                ST_Buffer(ST_Transform(v_origin, 3857), v_m_per_min * v_threshold), 4326);
            minutes := v_threshold;
            distance_m := v_m_per_min * v_threshold;
            geom := v_result;
            geojson := ST_AsGeoJSON(v_result);
            RETURN NEXT;
        END LOOP;
        RETURN;
    END IF;

    SELECT MAX(t) INTO v_max_cost FROM unnest(p_time_thresholds) AS t;

    -- ---------- 作用域 bbox ----------
    v_radius_m := v_max_cost * v_m_per_min * 1.2;
    v_dy := v_radius_m / 111320.0;                                   -- 纬度 1° ≈ 111.32km
    v_dx := v_radius_m / (111320.0 * COS(RADIANS(p_lat)));           -- 经度随纬度收缩

    -- ---------- 1. 只在邻域内跑路网分析 ----------
    v_edge_sql := format(
        'SELECT gid AS id, source, target,
                length_m / %1$s AS cost,
                length_m / %1$s AS reverse_cost
         FROM ways
         WHERE the_geom && ST_Expand(ST_SetSRID(ST_MakePoint(%2$s, %3$s), 4326), %4$s, %5$s)',
        v_m_per_min, p_lng, p_lat, v_dx, v_dy);

    DROP TABLE IF EXISTS temp_reachable_nodes;
    CREATE TEMP TABLE temp_reachable_nodes (
        node     BIGINT PRIMARY KEY,     -- 原实现没有索引，EXISTS 查询退化成全扫
        agg_cost DOUBLE PRECISION
    );

    INSERT INTO temp_reachable_nodes (node, agg_cost)
    SELECT dd.node, dd.agg_cost
    FROM pgr_drivingDistance(v_edge_sql, v_source_id, v_max_cost, FALSE) AS dd
    ON CONFLICT (node) DO NOTHING;

    CREATE INDEX ON temp_reachable_nodes (agg_cost);
    ANALYZE temp_reachable_nodes;

    -- ---------- 2. 一次扫描收齐所有阈值的点 ----------
    -- 每条可达边贡献起点/终点/中点，并记录该边的「达成成本」＝两端较大者，
    -- 之后按阈值过滤即可，不必为每个阈值重扫一遍。
    DROP TABLE IF EXISTS temp_hull_points;
    CREATE TEMP TABLE temp_hull_points AS
    SELECT v.the_geom AS pt, trn.agg_cost AS cost
    FROM temp_reachable_nodes trn
    JOIN ways_vertices_pgr v ON v.id = trn.node
    UNION ALL
    SELECT p.pt, GREATEST(s.agg_cost, t.agg_cost) AS cost
    FROM ways w
    JOIN temp_reachable_nodes s ON s.node = w.source
    JOIN temp_reachable_nodes t ON t.node = w.target
    CROSS JOIN LATERAL (
        VALUES (ST_StartPoint(w.the_geom)),
               (ST_EndPoint(w.the_geom)),
               (ST_LineInterpolatePoint(w.the_geom, 0.5))
    ) AS p(pt)
    WHERE w.the_geom && ST_Expand(ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326), v_dx, v_dy);

    CREATE INDEX ON temp_hull_points (cost);
    ANALYZE temp_hull_points;

    -- ---------- 3. 按阈值生成等时圈 ----------
    FOREACH v_threshold IN ARRAY p_time_thresholds LOOP
        SELECT ST_Collect(pt), COUNT(*) INTO v_collected, v_cnt
        FROM temp_hull_points WHERE cost <= v_threshold;

        IF v_cnt IS NULL OR v_cnt < 10 THEN
            v_result := ST_Transform(
                ST_Buffer(ST_Transform(v_origin, 3857), v_m_per_min * v_threshold), 4326);
        ELSE
            v_result := COALESCE(
                ST_ConcaveHull(v_collected, 0.75),
                ST_ConvexHull(v_collected),
                ST_Transform(
                    ST_Buffer(ST_Transform(v_origin, 3857), v_m_per_min * v_threshold), 4326));
        END IF;

        minutes := v_threshold;
        distance_m := v_m_per_min * v_threshold;
        geom := v_result;
        geojson := ST_AsGeoJSON(v_result);
        RETURN NEXT;
    END LOOP;

    DROP TABLE IF EXISTS temp_hull_points;
    DROP TABLE IF EXISTS temp_reachable_nodes;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_isochrones_optimized IS
  'v3：ConcaveHull pctconvex 0.5->0.75（主要收益）+ 邻域 bbox 限定 + 临时表索引 + 多阈值单次扫描';
