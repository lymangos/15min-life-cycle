package service

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/yourname/15min-life-circle/internal/database"
	"github.com/yourname/15min-life-circle/internal/model"
)

// IsochroneService 等时圈计算服务
type IsochroneService struct {
	db *database.DB
}

// NewIsochroneService 创建等时圈服务
func NewIsochroneService(db *database.DB) *IsochroneService {
	return &IsochroneService{db: db}
}

// Calculate 计算等时圈
func (s *IsochroneService) Calculate(ctx context.Context, req *model.IsochroneRequest) (*model.IsochroneResult, error) {
	req.Validate()

	result := &model.IsochroneResult{
		Origin:   model.Point{req.Lng, req.Lat},
		Polygons: make([]model.IsochronePolygon, 0, len(req.TimeThresholds)),
	}

	// 调用数据库函数计算各时间阈值的等时圈
	query := `
		SELECT 
			minutes,
			distance_m,
			geojson
		FROM calculate_isochrones($1, $2, $3, $4)
		ORDER BY minutes
	`

	rows, err := s.db.Pool.Query(ctx, query,
		req.Lng,
		req.Lat,
		req.TimeThresholds,
		req.WalkSpeed,
	)
	if err != nil {
		return nil, fmt.Errorf("calculate isochrones: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			minutes   int
			distance  float64
			geojsonStr string
		)
		if err := rows.Scan(&minutes, &distance, &geojsonStr); err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}

		// 解析 GeoJSON
		var geom model.Geometry
		if err := json.Unmarshal([]byte(geojsonStr), &geom); err != nil {
			return nil, fmt.Errorf("parse geojson: %w", err)
		}

		result.Polygons = append(result.Polygons, model.IsochronePolygon{
			Minutes:  minutes,
			Distance: distance,
			Geometry: geom,
		})
	}

	return result, nil
}

// CalculateAsGeoJSON 计算等时圈并返回 FeatureCollection
func (s *IsochroneService) CalculateAsGeoJSON(ctx context.Context, req *model.IsochroneRequest) (*model.FeatureCollection, error) {
	result, err := s.Calculate(ctx, req)
	if err != nil {
		return nil, err
	}
	return ToFeatureCollection(result), nil
}

// ToFeatureCollection 把已算好的等时圈结果转成 FeatureCollection。
//
// 单独拆出来是因为调用方常常两样都要：要 GeoJSON 给前端画，
// 又要原始多边形自己做几何运算。以前那种"先 CalculateAsGeoJSON 再 Calculate"
// 的写法会把整个等时圈计算跑两遍——在这台机器上是白扔一秒多。
func ToFeatureCollection(result *model.IsochroneResult) *model.FeatureCollection {
	fc := model.NewFeatureCollection()

	for _, p := range result.Polygons {
		feature := model.Feature{
			Type:     "Feature",
			Geometry: p.Geometry,
			Properties: map[string]interface{}{
				"minutes":  p.Minutes,
				"distance": p.Distance,
				"type":     "isochrone",
			},
		}
		fc.AddFeature(feature)
	}

	// 添加起点
	originFeature := model.NewPointFeature(result.Origin.Lng(), result.Origin.Lat(), map[string]interface{}{
		"type": "origin",
	})
	fc.AddFeature(originFeature)

	return fc
}

// GetReachableRoads 获取可达道路网络
func (s *IsochroneService) GetReachableRoads(ctx context.Context, lng, lat float64, minutes int, walkSpeed float64) (string, error) {
	query := `SELECT road_geojson FROM get_reachable_roads($1, $2, $3, $4)`
	
	var geojson string
	err := s.db.Pool.QueryRow(ctx, query, lng, lat, minutes, walkSpeed).Scan(&geojson)
	if err != nil {
		return "", fmt.Errorf("get reachable roads: %w", err)
	}
	
	return geojson, nil
}
