package config

import (
	"os"
)

// Config 应用配置
type Config struct {
	Server   ServerConfig
	Database DatabaseConfig
	Amap     AmapConfig
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Addr string
}

// DatabaseConfig 数据库配置
type DatabaseConfig struct {
	Host     string
	Port     string
	User     string
	Password string
	DBName   string
	SSLMode  string
}

// AmapConfig 高德地图API配置
type AmapConfig struct {
	Key     string
	Enabled bool
}

// DSN 返回数据库连接字符串
func (c DatabaseConfig) DSN() string {
	return "host=" + c.Host +
		" port=" + c.Port +
		" user=" + c.User +
		" password=" + c.Password +
		" dbname=" + c.DBName +
		" sslmode=" + c.SSLMode
}

// Load 加载配置（从环境变量）
func Load() (*Config, error) {
	// 默认值必须为空。这里原本硬编码了一把真实的高德 Key，有两个问题：
	// 一是密钥随源码进入公开仓库；二是下面的 getEnv 把空串也当作"未设置"，
	// 于是 AMAP_KEY= （有意留空以禁用高德）会被静默回落成"带着这把 key 启用"。
	// 密钥一律由环境变量提供，不进源码、不进二进制。
	amapKey := getEnv("AMAP_KEY", "")
	return &Config{
		Server: ServerConfig{
			Addr: getEnv("SERVER_ADDR", ":8080"),
		},
		Database: DatabaseConfig{
			Host:     getEnv("DB_HOST", "localhost"),
			Port:     getEnv("DB_PORT", "5432"),
			User:     getEnv("DB_USER", "postgres"),
			Password: getEnv("DB_PASSWORD", "postgres"),
			DBName:   getEnv("DB_NAME", "life_circle_15min"),
			SSLMode:  getEnv("DB_SSLMODE", "disable"),
		},
		Amap: AmapConfig{
			Key:     amapKey,
			Enabled: amapKey != "",
		},
	}, nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
