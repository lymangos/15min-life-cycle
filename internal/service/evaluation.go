package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strings"

	"github.com/yourname/15min-life-circle/internal/config"
	"github.com/yourname/15min-life-circle/internal/database"
	"github.com/yourname/15min-life-circle/internal/model"
)

// EvaluationService 评价服务
type EvaluationService struct {
	db          *database.DB
	poiService  *POIService
	amapService *AmapPOIService
}

// NewEvaluationService 创建评价服务
func NewEvaluationService(db *database.DB, poiService *POIService, cfg *config.Config) *EvaluationService {
	return &EvaluationService{
		db:          db,
		poiService:  poiService,
		amapService: NewAmapPOIService(cfg.Amap),
	}
}

// Evaluate 执行综合评价
func (s *EvaluationService) Evaluate(ctx context.Context, req *model.EvaluationRequest) (*model.EvaluationResult, error) {
	req.Validate()

	// 调用数据库评价函数（使用用户配置的步行速度）
	query := `
		SELECT 
			total_score,
			grade,
			category,
			category_name,
			-- 函数 RETURNS TABLE 声明的就是 category_weight；
			-- 这里原本写的 cat_weight 在库里不存在，/analyze 因此一直 500
			category_weight,
			category_score,
			weighted_score,
			poi_count,
			details
		FROM evaluate_life_circle($1, $2, $3)
	`

	rows, err := s.db.Pool.Query(ctx, query, req.Lng, req.Lat, req.WalkSpeed)
	if err != nil {
		return nil, fmt.Errorf("evaluate: %w", err)
	}
	defer rows.Close()

	result := &model.EvaluationResult{
		Origin:         model.Point{req.Lng, req.Lat},
		CategoryScores: make([]model.CategoryScore, 0),
	}

	for rows.Next() {
		var (
			totalScore     float64
			grade          string
			category       string
			categoryName   string
			categoryWeight float64
			categoryScore  float64
			weightedScore  float64
			poiCount       int64
			detailsJSON    []byte
		)

		if err := rows.Scan(
			&totalScore,
			&grade,
			&category,
			&categoryName,
			&categoryWeight,
			&categoryScore,
			&weightedScore,
			&poiCount,
			&detailsJSON,
		); err != nil {
			return nil, fmt.Errorf("scan result: %w", err)
		}

		result.TotalScore = totalScore
		result.Grade = strings.TrimSpace(grade)

		// 解析详情
		var details []model.SubTypeScore
		if err := json.Unmarshal(detailsJSON, &details); err != nil {
			// 忽略解析错误
			details = nil
		}

		catScore := model.CategoryScore{
			Category:      category,
			Name:          categoryName,
			Score:         categoryScore,
			Weight:        categoryWeight,
			WeightedScore: weightedScore,
			POICount:      int(poiCount),
			Details:       details,
		}
		result.CategoryScores = append(result.CategoryScores, catScore)
	}

	// 生成评价说明
	result.Summary = model.GetGradeDescription(result.Grade)

	// 生成改进建议
	result.Suggestions = s.generateSuggestions(result.CategoryScores)

	// 获取等时圈 GeoJSON（使用用户配置的步行速度）
	isoService := NewIsochroneService(s.db)
	isoReq := &model.IsochroneRequest{
		Lng:            req.Lng,
		Lat:            req.Lat,
		TimeThresholds: []int{5, 10, 15},
		WalkSpeed:      req.WalkSpeed,
	}
	// 等时圈只算一次：FeatureCollection 给前端，15 分钟那圈的原始几何用于过滤 POI。
	// 这里原本调完 CalculateAsGeoJSON 又调了一次 Calculate，而前者内部就是后者，
	// 等于把整个等时圈计算重跑一遍，白白多花一秒以上。
	var iso15GeoJSON string
	if isoResult, err := isoService.Calculate(ctx, isoReq); err == nil {
		result.Isochrone = ToFeatureCollection(isoResult)
		for _, poly := range isoResult.Polygons {
			if poly.Minutes == 15 {
				if geojsonBytes, err := json.Marshal(poly.Geometry); err == nil {
					iso15GeoJSON = string(geojsonBytes)
				}
				break
			}
		}
	}

	// 获取 POI GeoJSON（使用用户配置的步行速度）
	if pois, err := s.poiService.QueryInIsochrone(ctx, req.Lng, req.Lat, req.TimeThreshold, req.WalkSpeed); err == nil {
		// 尝试补充高德 POI 数据
		if s.amapService != nil && s.amapService.IsEnabled() {
			// 计算搜索半径（步行速度 * 15分钟）
			radius := int(req.WalkSpeed * 1000 / 60 * 15)
			if amapPOIs, err := s.amapService.SearchNearby(req.Lng, req.Lat, radius); err == nil {
				// 过滤高德POI：只保留等时圈内的
				if iso15GeoJSON != "" {
					filteredAmapPOIs := s.filterPOIsInIsochrone(ctx, amapPOIs, iso15GeoJSON)
					log.Printf("高德POI过滤：搜索 %d -> 圈内 %d", len(amapPOIs), len(filteredAmapPOIs))
					amapPOIs = filteredAmapPOIs
				}
				// 合并去重
				pois = s.mergePOIs(pois, amapPOIs)
				log.Printf("合并高德POI：总计 %d", len(pois))
			} else {
				log.Printf("高德POI查询失败: %v", err)
			}
		}
		result.POIs = s.poiService.POIsAsGeoJSON(pois)
	}

	// 获取可达道路网络
	if roadsJSON, err := isoService.GetReachableRoads(ctx, req.Lng, req.Lat, 15, req.WalkSpeed); err == nil && roadsJSON != "" {
		var roads interface{}
		if json.Unmarshal([]byte(roadsJSON), &roads) == nil {
			result.Roads = roads
		}
	}

	return result, nil
}

// mergePOIs 合并本地和高德POI（去重）
func (s *EvaluationService) mergePOIs(localPOIs []model.POI, amapPOIs []model.POI) []model.POI {
	// 用于去重的集合（基于位置和名称）
	seen := make(map[string]bool)
	
	// 先添加本地POI并标记source
	result := make([]model.POI, len(localPOIs))
	for i, poi := range localPOIs {
		key := fmt.Sprintf("%.5f,%.5f,%s", poi.Lng, poi.Lat, poi.Name)
		seen[key] = true
		poi.Source = "osm"
		result[i] = poi
	}
	
	// 添加不重复的高德POI
	for _, poi := range amapPOIs {
		key := fmt.Sprintf("%.5f,%.5f,%s", poi.Lng, poi.Lat, poi.Name)
		
		// 检查是否已存在类似POI（距离在50米内且名称相似）
		isDuplicate := seen[key]
		if !isDuplicate {
			// 还可以检查附近是否有同名POI
			for _, local := range localPOIs {
				dist := distance(poi.Lng, poi.Lat, local.Lng, local.Lat)
				// 修复运算符优先级问题
				if dist < 50 && (strings.Contains(poi.Name, local.Name) || strings.Contains(local.Name, poi.Name)) {
					isDuplicate = true
					break
				}
			}
		}
		
		if !isDuplicate {
			result = append(result, poi)
			seen[key] = true
		}
	}
	
	return result
}

// distance 计算两点间距离（米）- 简化版
func distance(lng1, lat1, lng2, lat2 float64) float64 {
	// 简单的欧几里得距离近似（适用于小范围）
	// 1度纬度约111km，1度经度在杭州约90km
	dLat := (lat2 - lat1) * 111000
	dLng := (lng2 - lng1) * 90000
	// 修复: 使用 math.Sqrt 计算实际距离
	return math.Sqrt(dLat*dLat + dLng*dLng)
}

// filterPOIsInIsochrone 使用数据库空间查询过滤POI是否在等时圈内
func (s *EvaluationService) filterPOIsInIsochrone(ctx context.Context, pois []model.POI, isochroneGeoJSON string) []model.POI {
	if isochroneGeoJSON == "" || len(pois) == 0 {
		return pois
	}

	// 批量查询优化：构建临时表并一次性检查所有点
	// 构建POI点数组用于批量查询
	type poiPoint struct {
		Idx int
		Lng float64
		Lat float64
	}
	points := make([]poiPoint, len(pois))
	for i, poi := range pois {
		points[i] = poiPoint{Idx: i, Lng: poi.Lng, Lat: poi.Lat}
	}

	// 使用单次批量查询检查所有点
	query := `
		WITH poi_points AS (
			SELECT idx, ST_SetSRID(ST_MakePoint(lng, lat), 4326) as geom
			FROM unnest($1::int[], $2::float8[], $3::float8[]) AS t(idx, lng, lat)
		),
		isochrone AS (
			SELECT ST_GeomFromGeoJSON($4) as geom
		)
		SELECT p.idx 
		FROM poi_points p, isochrone i
		WHERE ST_Within(p.geom, i.geom)
	`

	idxs := make([]int, len(points))
	lngs := make([]float64, len(points))
	lats := make([]float64, len(points))
	for i, p := range points {
		idxs[i] = p.Idx
		lngs[i] = p.Lng
		lats[i] = p.Lat
	}

	rows, err := s.db.Pool.Query(ctx, query, idxs, lngs, lats, isochroneGeoJSON)
	if err != nil {
		log.Printf("批量POI过滤查询失败: %v", err)
		return pois // 出错时返回原始POI
	}
	defer rows.Close()

	validIdxs := make(map[int]bool)
	for rows.Next() {
		var idx int
		if err := rows.Scan(&idx); err == nil {
			validIdxs[idx] = true
		}
	}

	var filtered []model.POI
	for i, poi := range pois {
		if validIdxs[i] {
			filtered = append(filtered, poi)
		}
	}
	return filtered
}

// generateSuggestions 根据评分生成改进建议
func (s *EvaluationService) generateSuggestions(scores []model.CategoryScore) []string {
	var suggestions []string

	categoryNames := map[string]string{
		"medical":   "医疗卫生",
		"education": "教育设施",
		"commerce":  "商业服务",
		"culture":   "文化体育",
		"public":    "公共服务",
		"transport": "交通设施",
		"elderly":   "养老服务",
	}

	for _, cs := range scores {
		if cs.Score < 60 {
			name := categoryNames[cs.Category]
			if name == "" {
				name = cs.Name
			}
			suggestions = append(suggestions,
				fmt.Sprintf("【%s】设施覆盖不足（得分%.1f），建议增设相关配套设施", name, cs.Score))
		}
	}

	if len(suggestions) == 0 {
		suggestions = append(suggestions, "当前区域生活圈配套较为完善，建议保持现有服务水平")
	}

	return suggestions
}

// GetStandards 获取评价标准
func (s *EvaluationService) GetStandards(ctx context.Context) ([]model.EvaluationStandard, error) {
	query := `
		SELECT 
			category,
			sub_type,
			min_count_5,
			min_count_10,
			min_count_15,
			is_required,
			base_score
		FROM evaluation_standard
		ORDER BY category, sub_type
	`

	rows, err := s.db.Pool.Query(ctx, query)
	if err != nil {
		// 如果表不存在，返回默认标准
		return model.GetDefaultStandards(), nil
	}
	defer rows.Close()

	var standards []model.EvaluationStandard
	for rows.Next() {
		var std model.EvaluationStandard
		if err := rows.Scan(
			&std.Category,
			&std.SubType,
			&std.MinCount5,
			&std.MinCount10,
			&std.MinCount15,
			&std.Required,
			&std.BaseScore,
		); err != nil {
			return nil, fmt.Errorf("scan standard: %w", err)
		}
		standards = append(standards, std)
	}

	if len(standards) == 0 {
		return model.GetDefaultStandards(), nil
	}

	return standards, nil
}
