package service

import (
	"context"
	"fmt"
	"sync"

	"github.com/yourname/15min-life-circle/internal/database"
)

// SnapRadiusM 起点到最近路网节点的最大容忍距离（米）。
//
// 超过这个距离，pgr_drivingDistance 仍然会找到"最近"的节点并正常返回，
// 只是那个节点跟用户点的地方已经没关系了——等时圈看着像模像样，其实是错的。
// 与其给出一个静默错误的结果，不如直接拒绝并说清楚原因。
const SnapRadiusM = 300

// Coverage 描述这套数据实际能分析的范围。
//
// 路网是按矩形从 OSM 裁出来的：ways 与 ways_vertices_pgr 的 bbox 四条边
// 重合到小数点后 4 位以上，说明边界本身就是一个矩形，
// 所以下面这个 bbox 是真实边界，不是外接近似。
type Coverage struct {
	Name        string `json:"name"`
	Description string `json:"description"`

	MinLng float64 `json:"min_lng"`
	MinLat float64 `json:"min_lat"`
	MaxLng float64 `json:"max_lng"`
	MaxLat float64 `json:"max_lat"`

	CenterLng float64 `json:"center_lng"`
	CenterLat float64 `json:"center_lat"`

	// 大致跨度（公里），给前端做文案用
	SpanLngKm float64 `json:"span_lng_km"`
	SpanLatKm float64 `json:"span_lat_km"`

	Ways     int `json:"ways"`
	Vertices int `json:"vertices"`
	POIs     int `json:"pois"`

	SnapRadiusM float64 `json:"snap_radius_m"`
}

// Contains 判断点是否落在数据矩形内。纯算术，不查库。
func (c *Coverage) Contains(lng, lat float64) bool {
	return lng >= c.MinLng && lng <= c.MaxLng && lat >= c.MinLat && lat <= c.MaxLat
}

// OutOfCoverageError 起点不可分析。分两种：压根不在矩形里，或在矩形里但附近没有路。
type OutOfCoverageError struct {
	// out_of_bbox | no_road_nearby
	Reason    string
	DistanceM float64
	Coverage  *Coverage
}

func (e *OutOfCoverageError) Error() string {
	if e.Reason == "no_road_nearby" {
		return fmt.Sprintf("最近的路网节点在 %.0f 米外，超过 %d 米上限，无法从这里起算",
			e.DistanceM, int(SnapRadiusM))
	}
	return "该点在当前数据覆盖范围之外"
}

// CoverageService 提供数据覆盖范围，并校验起点是否可分析。
type CoverageService struct {
	db     *database.DB
	once   sync.Once
	cached *Coverage
	err    error
}

func NewCoverageService(db *database.DB) *CoverageService {
	return &CoverageService{db: db}
}

// Get 返回覆盖范围。范围在运行期不会变，所以只查一次。
func (s *CoverageService) Get(ctx context.Context) (*Coverage, error) {
	s.once.Do(func() {
		s.cached, s.err = s.load(ctx)
	})
	return s.cached, s.err
}

func (s *CoverageService) load(ctx context.Context) (*Coverage, error) {
	const q = `
		WITH e AS (SELECT ST_Extent(the_geom) AS g FROM ways_vertices_pgr)
		SELECT
			ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g),
			(SELECT count(*) FROM ways),
			(SELECT count(*) FROM ways_vertices_pgr),
			(SELECT count(*) FROM poi)
		FROM e`

	c := &Coverage{
		Name:        "杭州西湖区一带",
		Description: "杭州西湖区及周边，按矩形裁取的 OSM 路网",
		SnapRadiusM: SnapRadiusM,
	}

	err := s.db.QueryRow(ctx, q).Scan(
		&c.MinLng, &c.MinLat, &c.MaxLng, &c.MaxLat,
		&c.Ways, &c.Vertices, &c.POIs,
	)
	if err != nil {
		return nil, fmt.Errorf("load coverage extent: %w", err)
	}

	c.CenterLng = (c.MinLng + c.MaxLng) / 2
	c.CenterLat = (c.MinLat + c.MaxLat) / 2

	// 这个纬度上 1° 纬度约 111km，1° 经度约 111*cos(30.24°) ≈ 96km。
	// 只用于生成"约 9×9 公里"这类文案，不参与任何判断，所以常数够用。
	c.SpanLngKm = (c.MaxLng - c.MinLng) * 96.0
	c.SpanLatKm = (c.MaxLat - c.MinLat) * 111.0

	return c, nil
}

// Check 校验起点能否分析。先做矩形判断（不查库），再查最近路网节点距离。
func (s *CoverageService) Check(ctx context.Context, lng, lat float64) error {
	cov, err := s.Get(ctx)
	if err != nil {
		return err
	}

	if !cov.Contains(lng, lat) {
		return &OutOfCoverageError{Reason: "out_of_bbox", Coverage: cov}
	}

	// <-> 走 GIST 索引，代价可忽略
	const q = `
		SELECT ST_Distance(
			v.the_geom::geography,
			ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
		)
		FROM ways_vertices_pgr v
		ORDER BY v.the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
		LIMIT 1`

	var dist float64
	if err := s.db.QueryRow(ctx, q, lng, lat).Scan(&dist); err != nil {
		return fmt.Errorf("nearest vertex: %w", err)
	}

	if dist > SnapRadiusM {
		return &OutOfCoverageError{Reason: "no_road_nearby", DistanceM: dist, Coverage: cov}
	}
	return nil
}
