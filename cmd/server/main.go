package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourname/15min-life-circle/internal/api"
	"github.com/yourname/15min-life-circle/internal/config"
	"github.com/yourname/15min-life-circle/internal/database"
	"github.com/yourname/15min-life-circle/internal/service"
)

func main() {
	// 加载配置
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// 连接数据库
	db, err := database.Connect(cfg.Database)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// 初始化服务层
	isochroneService := service.NewIsochroneService(db)
	poiService := service.NewPOIService(db)
	evaluationService := service.NewEvaluationService(db, poiService, cfg)
	coverageService := service.NewCoverageService(db)

	// 打印高德API状态
	if cfg.Amap.Enabled {
		log.Println("高德POI服务已启用")
	} else {
		log.Println("高德POI服务未启用（无API Key）")
	}

	// 设置 Gin 路由
	router := gin.Default()

	// 静态文件
	router.Static("/static", "./web/static")
	router.LoadHTMLGlob("web/templates/*")

	// 页面路由
	router.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "index.html", nil)
	})

	// API 路由
	apiGroup := router.Group("/api/v1")
	{
		handler := api.NewHandler(isochroneService, poiService, evaluationService, coverageService, cfg)
		apiGroup.POST("/isochrone", handler.CalculateIsochrone)
		apiGroup.POST("/analyze", handler.AnalyzePoint)
		apiGroup.GET("/poi/categories", handler.GetPOICategories)
		apiGroup.GET("/evaluation/standards", handler.GetEvaluationStandards)
		apiGroup.GET("/coverage", handler.GetCoverage)
	}

	// 启动服务器
	srv := &http.Server{
		Addr:    cfg.Server.Addr,
		Handler: router,
	}

	// 优雅关闭
	go func() {
		log.Printf("Server starting on %s", cfg.Server.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exited")
}
