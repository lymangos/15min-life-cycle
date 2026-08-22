-- ============================================================
-- 008：修复 evaluate_life_circle（/api/v1/analyze 的唯一数据源）
--
-- 这个接口部署后一直是 500，实际上叠了三个独立的 bug，前两个把第三个
-- 遮住了 —— 查询在**规划阶段**就报错，所以从来没人看到它真正跑起来有多慢。
--
-- 1. 列名对不上（Go 侧，42703）
--    internal/service/evaluation.go 的 SELECT 列表写的是 cat_weight，
--    而函数 RETURNS TABLE 声明的是 category_weight。报
--    `column "cat_weight" does not exist`。已在 Go 侧改成 category_weight。
--
-- 2. category_weight 引用有歧义（本文件，42702）
--    PL/pgSQL 会把 RETURNS TABLE 的每个列名注册成同名变量。函数体 total
--    这个 CTE 里写的是裸列名 category_weight，于是它既能指变量又能指
--    category_summary 的列，Postgres 直接拒绝：
--      column reference "category_weight" is ambiguous
--    修法是给 CTE 起别名并全部限定为 cs2.category_weight。没有用
--    `#variable_conflict use_column` —— 那是全函数级的隐式规则，
--    以后有人加一列就可能悄悄改变解析结果，限定写法把意图钉死在字面上。
--
-- 3. 真正的性能地雷：走的是没被 007 优化的那条路径
--    原实现调 3 次**单数** calculate_isochrone(lng, lat, minutes, speed)，
--    它转发给 calculate_isochrone_v2 —— 而 007 优化的是**复数**
--    calculate_isochrones（ST_ConcaveHull 的 pctconvex 0.5→0.75）。
--    单数版实测单次 61 秒，三次就是 ~3 分钟，且全程占着 320MB 的
--    Postgres。在这台 2 核 893MiB、还跑着主站 Caddy 的机器上，
--    一个匿名 POST 就能把整机拖垮 —— 和之前在服务器上跑 go build
--    把主站饿死 25 分钟是同一类事故。
--    改成调一次复数版，三个阈值一起算完。
--
-- 另外把总分的除法加了 NULLIF 保护：poi_category 全部权重为 0 时
-- 原式子会 division by zero。
-- ============================================================

CREATE OR REPLACE FUNCTION evaluate_life_circle(
    p_lng DOUBLE PRECISION,
    p_lat DOUBLE PRECISION,
    p_walk_speed_kmh DOUBLE PRECISION DEFAULT 5.0
)
RETURNS TABLE (
    total_score DECIMAL,
    grade CHAR(1),
    category VARCHAR,
    category_name VARCHAR,
    category_weight DECIMAL,
    category_score DECIMAL,
    weighted_score DECIMAL,
    poi_count BIGINT,
    details JSONB
) AS $$
BEGIN
    RETURN QUERY
    WITH
    -- 一次调用拿到 5/10/15 三个阈值。这里必须是复数版：
    -- 单数 calculate_isochrone 走的是未优化的 v2，单次 61 秒。
    isochrones AS (
        SELECT ci.minutes, ci.geom
        FROM calculate_isochrones(
                 p_lng, p_lat, ARRAY[5, 10, 15], p_walk_speed_kmh
             ) ci
    ),
    -- 统计各等时圈内的 POI
    poi_counts AS (
        SELECT
            p.category,
            p.sub_type,
            i.minutes,
            COUNT(*)::INT AS cnt
        FROM poi p
        CROSS JOIN isochrones i
        WHERE ST_Within(p.geom, i.geom)
        GROUP BY p.category, p.sub_type, i.minutes
    ),
    -- 计算子类型得分
    subtype_scores AS (
        SELECT
            es.category,
            es.sub_type,
            COALESCE(pc5.cnt, 0) AS count_5,
            COALESCE(pc10.cnt, 0) AS count_10,
            COALESCE(pc15.cnt, 0) AS count_15,
            es.min_count_5,
            es.min_count_10,
            es.min_count_15,
            es.is_required,
            es.base_score,
            -- 满足要求得满分，部分满足按比例
            CASE
                WHEN COALESCE(pc15.cnt, 0) >= es.min_count_15 THEN es.base_score
                WHEN es.min_count_15 > 0 THEN
                    es.base_score * COALESCE(pc15.cnt, 0)::DECIMAL / es.min_count_15
                ELSE es.base_score
            END AS score
        FROM evaluation_standard es
        LEFT JOIN poi_counts pc5 ON pc5.category = es.category
            AND pc5.sub_type = es.sub_type AND pc5.minutes = 5
        LEFT JOIN poi_counts pc10 ON pc10.category = es.category
            AND pc10.sub_type = es.sub_type AND pc10.minutes = 10
        LEFT JOIN poi_counts pc15 ON pc15.category = es.category
            AND pc15.sub_type = es.sub_type AND pc15.minutes = 15
    ),
    -- 按分类汇总
    category_summary AS (
        SELECT
            ss.category,
            c.name   AS category_name,
            c.weight AS category_weight,
            SUM(ss.score)      AS raw_score,
            SUM(ss.base_score) AS max_score,
            SUM(ss.count_15)   AS total_poi_count,
            JSONB_AGG(
                JSONB_BUILD_OBJECT(
                    'sub_type', ss.sub_type,
                    'count_5', ss.count_5,
                    'count_10', ss.count_10,
                    'count_15', ss.count_15,
                    'required', ss.min_count_15,
                    'score', ss.score,
                    'max_score', ss.base_score,
                    'is_required', ss.is_required
                )
            ) AS sub_details
        FROM subtype_scores ss
        JOIN poi_category c ON c.code = ss.category
        GROUP BY ss.category, c.name, c.weight
    ),
    -- 归一化到 100 分制。
    -- cs2 别名 + 全限定：category_weight 同时是本函数的 OUT 参数名，
    -- 裸写会被判为 ambiguous（见文件头第 2 条）。
    total AS (
        SELECT
            ROUND(
                SUM(
                    CASE
                        WHEN cs2.max_score > 0
                        THEN (cs2.raw_score / cs2.max_score) * 100 * cs2.category_weight
                        ELSE 0
                    END
                ) / NULLIF(SUM(cs2.category_weight), 0),
                2
            ) AS total_score
        FROM category_summary cs2
    )
    SELECT
        t.total_score,
        CASE
            WHEN t.total_score >= 90 THEN 'A'
            WHEN t.total_score >= 75 THEN 'B'
            WHEN t.total_score >= 60 THEN 'C'
            WHEN t.total_score >= 45 THEN 'D'
            ELSE 'E'
        END::CHAR(1) AS grade,
        cs.category,
        cs.category_name,
        cs.category_weight,
        ROUND(CASE WHEN cs.max_score > 0 THEN cs.raw_score / cs.max_score * 100 ELSE 0 END, 2) AS category_score,
        ROUND(CASE WHEN cs.max_score > 0 THEN cs.raw_score / cs.max_score * 100 * cs.category_weight ELSE 0 END, 2) AS weighted_score,
        cs.total_poi_count,
        cs.sub_details
    FROM category_summary cs
    CROSS JOIN total t
    ORDER BY cs.category;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION evaluate_life_circle IS
    '综合评价15分钟生活圈服务覆盖度。等时圈走 calculate_isochrones（007 优化版），不要改回单数版。';
