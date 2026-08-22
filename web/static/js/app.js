/**
 * 15分钟生活圈 - 前端应用
 */

// ============================================
// 城市配置
// ============================================

// 这里原本硬编码了杭州 / 诸暨 / 沈阳三个城市，每个都配了一个手写的 bounds。
// 但库里其实只有一块按矩形从 OSM 裁出来的杭州路网（ways_vertices_pgr 的 extent），
// 另外两个城市一条路都没有——选中它们只会得到一个静默错误的结果。
// 现在范围由后端 /api/v1/coverage 提供，前端不再自己编造边界。
// 下面这份只是接口未就绪时的兜底，数值与线上一致。
const FALLBACK_COVERAGE = {
    name: '杭州西湖区一带',
    description: '按矩形裁取的 OSM 路网',
    min_lng: 120.1109878, min_lat: 30.2018569,
    max_lng: 120.2064578, max_lat: 30.2873602,
    center_lng: 120.1587228, center_lat: 30.2446086,
    span_lng_km: 9.2, span_lat_km: 9.5,
    ways: 16287, vertices: 12310, pois: 2038,
    snap_radius_m: 300
};

// 曾经在选择器里出现、但库中没有数据的城市。
// 留成不可选项而不是直接删掉，是为了让"以前能选、现在不能"有个交代，
// 免得用户以为选项消失是个 bug。
const UNAVAILABLE_CITIES = ['诸暨', '沈阳'];

// ============================================
// 配置
// ============================================

const CONFIG = {
    // 当前数据覆盖范围，启动时由 /api/v1/coverage 覆写
    coverage: FALLBACK_COVERAGE,

    get defaultCenter() { return [this.coverage.center_lat, this.coverage.center_lng]; },
    get defaultZoom() { return 14; },
    // Leaflet 用 [[南, 西], [北, 东]]
    get cityBounds() {
        const c = this.coverage;
        return [[c.min_lat, c.min_lng], [c.max_lat, c.max_lng]];
    },
    
    // API 端点
    apiBase: '/api/v1',
    
    // 高德地图 API Key（Web服务）
    // 注意：实际使用时请替换为您自己的 Key
    amapKey: '',  // 留空则使用本地 Nominatim
    
    // 等时圈样式 - 参照示例图片
    isochroneStyles: {
        5: { 
            color: '#15803d',      // 深绿色边框
            fillColor: '#22c55e',   // 绿色填充
            fillOpacity: 0.4, 
            weight: 2.5,
            dashArray: null
        },
        10: { 
            color: '#1d4ed8',      // 深蓝色边框
            fillColor: '#3b82f6',   // 蓝色填充
            fillOpacity: 0.35, 
            weight: 2,
            dashArray: null
        },
        15: { 
            color: '#c2410c',      // 深橙色边框
            fillColor: '#f97316',   // 橙色填充
            fillOpacity: 0.25, 
            weight: 1.5,
            dashArray: null
        }
    },
    
    // POI 分类图标
    categoryIcons: {
        medical: '🏥',
        education: '🏫',
        elderly: '👴',
        commerce: '🛒',
        culture: '🎭',
        public: '🏛️',
        transport: '🚌',
        child: '👶'
    },
    
    // POI 分类颜色
    categoryColors: {
        medical: '#e74c3c',
        education: '#3498db',
        elderly: '#e67e22',
        commerce: '#f39c12',
        culture: '#27ae60',
        public: '#9b59b6',
        transport: '#1abc9c',
        child: '#ff69b4'
    }
};

// ============================================
// 应用状态
// ============================================

const state = {
    map: null,
    currentMarker: null,
    isochroneLayer: null,
    poiLayer: null,
    roadsLayer: null,        // 道路网络图层
    selectedLocation: null,
    // 新增状态
    walkSpeed: 5.0,          // 步行速度 km/h
    categoryFilters: {       // POI 分类筛选状态
        medical: true,
        education: true,
        elderly: true,
        commerce: true,
        culture: true,
        public: true,
        transport: true,
        child: true
    },
    isochroneVisibility: {   // 等时圈可见性
        5: true,
        10: true,
        15: true
    },
    roadsVisible: false,     // 道路网络可见性
    isochroneLayers: {       // 分开存储各等时圈图层
        5: null,
        10: null,
        15: null
    },
    currentIsochroneData: null, // 缓存当前等时圈数据
    currentRoadsData: null,  // 缓存当前道路网络数据
    currentPOIs: null,       // 当前 POI features 数组（用于统计）
    currentPOIsGeoJSON: null, // 当前 POI GeoJSON 对象（用于渲染）
    currentResult: null,     // 当前分析结果缓存
    radarChart: null,        // ECharts 雷达图实例
    coverageRect: null,      // 可分析区域轮廓
    coverageMask: null,      // 区域外的压暗遮罩
    coverageTip: null,       // 贴在区域上边缘的标签
    baseLayers: null,        // 底图图层
    isMobile: false          // 是否移动端
};

// ============================================
// 初始化
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    // 检测移动端
    state.isMobile = window.innerWidth <= 768;

    // 地图边界依赖真实数据范围，必须先拿到再建图
    await loadCoverage();

    initMap();
    initEventListeners();
    initRadarChart();
    initCitySelector();
    initMobileControls();
});

/**
 * 拉取真实数据覆盖范围。失败则沿用兜底值，不阻断页面。
 */
async function loadCoverage() {
    try {
        const res = await fetch(`${CONFIG.apiBase}/coverage`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cov = await res.json();
        if (typeof cov.min_lng === 'number' && cov.max_lng > cov.min_lng) {
            CONFIG.coverage = cov;
        }
    } catch (err) {
        console.warn('覆盖范围接口不可用，使用兜底值：', err);
    }
}

/**
 * 点是否落在可分析范围内
 */
function inCoverage(lat, lng) {
    const c = CONFIG.coverage;
    return lng >= c.min_lng && lng <= c.max_lng && lat >= c.min_lat && lat <= c.max_lat;
}

/**
 * 越界就提示并闪一下区域轮廓，返回 true 表示调用方应当中止。
 * what 用于拼文案，比如「该位置」「搜索结果」。
 */
function rejectOutside(lat, lng, what) {
    if (inCoverage(lat, lng)) return false;
    showToast(`${what}在可分析范围外，目前只有${CONFIG.coverage.name}有路网数据`, 'error');
    flashCoverage();
    return true;
}

/**
 * 让区域轮廓闪两下，把「能点哪儿」指出来
 */
function flashCoverage() {
    if (!state.coverageRect) return;
    const rect = state.coverageRect;
    let n = 0;
    const timer = setInterval(() => {
        rect.setStyle({ weight: n % 2 ? 2.5 : 6, color: n % 2 ? '#2563eb' : '#f59e0b' });
        if (++n >= 6) {
            clearInterval(timer);
            rect.setStyle({ weight: 2.5, color: '#2563eb' });
        }
    }, 180);
}

/**
 * 初始化移动端控制
 */
function initMobileControls() {
    const toggleBtn = document.getElementById('toggle-sidebar');
    const closeBtn = document.getElementById('close-sidebar');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const mobileLocateBtn = document.getElementById('mobile-locate-btn');
    
    // 打开侧边栏
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            sidebar.classList.add('open');
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        });
    }
    
    // 关闭侧边栏
    const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    };
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeSidebar);
    }
    
    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }
    
    // 移动端定位按钮
    if (mobileLocateBtn) {
        mobileLocateBtn.addEventListener('click', handleLocate);
    }
    
    // 分析完成后自动关闭侧边栏（移动端）
    window.closeSidebarAfterAnalysis = () => {
        if (state.isMobile && sidebar.classList.contains('open')) {
            closeSidebar();
        }
    };
    
    // 监听窗口大小变化
    window.addEventListener('resize', () => {
        state.isMobile = window.innerWidth <= 768;
        // 桌面端确保侧边栏可见
        if (!state.isMobile) {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
}

/**
 * 初始化地图
 */
function initMap() {
    // 获取城市边界
    const bounds = L.latLngBounds(CONFIG.cityBounds);
    
    // 创建地图，设置边界限制
    state.map = L.map('map', {
        maxBounds: bounds.pad(0.1),  // 稍微扩展边界，让边缘可见
        maxBoundsViscosity: 1.0,     // 完全限制在边界内
        tap: true,                   // 移动端点击支持
        touchZoom: true,             // 触摸缩放
        bounceAtZoomLimits: false    // 缩放限制时不反弹
    }).setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
    
    // 添加底图 - 使用高德瓦片（国内访问快，边界合规）
    const amapTile = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        attribution: '&copy; 高德地图'
    });
    
    amapTile.addTo(state.map);
    
    // 添加城市边界可视化
    updateCityBoundsRect();
    
    // 添加比例尺
    L.control.scale({ imperial: false }).addTo(state.map);
    
    // 初始化图层组（道路在最底层，等时圈在上面，POI在最上面）
    state.roadsLayer = L.layerGroup().addTo(state.map);
    state.isochroneLayer = L.layerGroup().addTo(state.map);
    state.poiLayer = L.layerGroup().addTo(state.map);
    
    // 地图点击事件
    state.map.on('click', handleMapClick);
}

/**
 * 初始化事件监听
 */
function initEventListeners() {
    // 步行速度滑块
    const speedSlider = document.getElementById('walk-speed');
    if (speedSlider) {
        speedSlider.addEventListener('input', handleSpeedChange);
    }
    
    // 速度预设按钮
    document.querySelectorAll('.speed-preset').forEach(btn => {
        btn.addEventListener('click', handleSpeedPreset);
    });
    
    // POI 筛选复选框
    document.querySelectorAll('#poi-filter-list .filter-checkbox input').forEach(checkbox => {
        checkbox.addEventListener('change', handleCategoryFilter);
    });
    
    // 全选/取消全选
    const filterAll = document.getElementById('filter-all');
    if (filterAll) {
        filterAll.addEventListener('change', handleFilterAll);
    }
    
    // 等时圈图层开关
    document.querySelectorAll('#isochrone-control-panel input[type="checkbox"]').forEach(checkbox => {
        if (checkbox.id === 'show-roads') {
            checkbox.addEventListener('change', handleRoadsToggle);
        } else {
            checkbox.addEventListener('change', handleIsochroneToggle);
        }
    });
    
    // 搜索功能
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const locateBtn = document.getElementById('locate-btn');
    
    if (searchInput) {
        // 输入时搜索建议
        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                handleSearchInput(e.target.value);
            }, 300);
        });
        
        // 回车搜索
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSearch(searchInput.value);
            }
        });
        
        // 点击其他地方关闭搜索结果
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#search-panel')) {
                hideSearchResults();
            }
        });
    }
    
    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            handleSearch(document.getElementById('search-input').value);
        });
    }
    
    if (locateBtn) {
        locateBtn.addEventListener('click', handleLocate);
    }
}

// ============================================
// 地址搜索功能
// ============================================

/**
 * 处理搜索输入（显示建议）
 */
async function handleSearchInput(query) {
    if (!query || query.length < 2) {
        hideSearchResults();
        return;
    }
    
    try {
        const results = await searchAddress(query);
        showSearchResults(results);
    } catch (error) {
        console.error('Search failed:', error);
    }
}

/**
 * 执行搜索
 */
async function handleSearch(query) {
    if (!query) return;
    
    try {
        const results = await searchAddress(query);
        if (results.length > 0) {
            // 选择第一个结果
            selectSearchResult(results[0]);
        } else {
            // 搜索已限定在覆盖范围内，空结果多半是因为目标不在框里
            showToast(`在${CONFIG.coverage.name}范围内没找到「${query}」`, 'error');
            flashCoverage();
        }
    } catch (error) {
        console.error('Search failed:', error);
        showToast('搜索失败，请重试', 'error');
    }
}

/**
 * 搜索地址（使用 Nominatim 免费 API）
 */
async function searchAddress(query) {
    // 使用 OpenStreetMap Nominatim API（免费，无需 Key）
    // viewbox + bounded=1 让 Nominatim 只返回框内结果，
    // 省得用户搜到一个根本没法分析的地方再被拒绝
    const c = CONFIG.coverage;
    const viewbox = `${c.min_lng},${c.max_lat},${c.max_lng},${c.min_lat}`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`
        + `&countrycodes=cn&limit=5&addressdetails=1&viewbox=${viewbox}&bounded=1`;
    
    const response = await fetch(url, {
        headers: {
            'Accept-Language': 'zh-CN,zh'
        }
    });
    
    if (!response.ok) {
        throw new Error('Search API failed');
    }
    
    const data = await response.json();
    
    // bounded=1 理论上够了，这里再滤一道，避免服务端忽略参数时漏过去
    return data.map(item => ({
        name: item.display_name.split(',')[0],
        address: item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon)
    })).filter(r => inCoverage(r.lat, r.lng));
}

/**
 * 显示搜索结果
 */
function showSearchResults(results) {
    const container = document.getElementById('search-results');
    
    if (!results || results.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.innerHTML = results.map((r, i) => `
        <div class="search-result-item" data-index="${i}">
            <div class="name">${r.name}</div>
            <div class="address">${r.address}</div>
        </div>
    `).join('');
    
    // 添加点击事件
    container.querySelectorAll('.search-result-item').forEach((item, i) => {
        item.addEventListener('click', () => {
            selectSearchResult(results[i]);
        });
    });
    
    container.style.display = 'block';
}

/**
 * 隐藏搜索结果
 */
function hideSearchResults() {
    const container = document.getElementById('search-results');
    if (container) {
        container.style.display = 'none';
    }
}

/**
 * 选择搜索结果
 */
function selectSearchResult(result) {
    hideSearchResults();
    document.getElementById('search-input').value = result.name;

    if (rejectOutside(result.lat, result.lng, `「${result.name}」`)) return;
    
    // 跳转到该位置
    state.map.setView([result.lat, result.lng], 16);
    
    // 更新状态并分析
    state.selectedLocation = { lat: result.lat, lng: result.lng };
    updateLocationDisplay(result.lat, result.lng);
    updateMarker(result.lat, result.lng);
    analyzePoint(result.lng, result.lat);
    
    showToast(`已定位到: ${result.name}`, 'success');
}

// ============================================
// 当前位置定位
// ============================================

/**
 * 处理定位按钮点击
 */
function handleLocate() {
    const locateBtn = document.getElementById('locate-btn');
    
    if (!navigator.geolocation) {
        showToast('您的浏览器不支持定位功能', 'error');
        return;
    }
    
    // 显示定位中状态
    locateBtn.classList.add('locating');
    locateBtn.textContent = '⏳';
    
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            
            // 恢复按钮状态
            locateBtn.classList.remove('locating');
            locateBtn.textContent = '📍';
            
            // 当前位置多半不在这块数据里，给出明确说明而不是算个错的
            if (!inCoverage(latitude, longitude)) {
                showToast(`你的位置不在可分析范围内，已带你到${CONFIG.coverage.name}`, 'info');
                state.map.flyTo(CONFIG.defaultCenter, CONFIG.defaultZoom);
                flashCoverage();
                return;
            }

            // 跳转到当前位置
            state.map.setView([latitude, longitude], 16);
            
            // 更新状态并分析
            state.selectedLocation = { lat: latitude, lng: longitude };
            updateLocationDisplay(latitude, longitude);
            updateMarker(latitude, longitude);
            analyzePoint(longitude, latitude);
            
            showToast('已定位到当前位置', 'success');
        },
        (error) => {
            // 恢复按钮状态
            locateBtn.classList.remove('locating');
            locateBtn.textContent = '📍';
            
            let message = '定位失败';
            switch (error.code) {
                case error.PERMISSION_DENIED:
                    message = '定位权限被拒绝，请在浏览器设置中允许';
                    break;
                case error.POSITION_UNAVAILABLE:
                    message = '无法获取位置信息';
                    break;
                case error.TIMEOUT:
                    message = '定位超时，请重试';
                    break;
            }
            showToast(message, 'error');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000
        }
    );
}

// ============================================
// Toast 提示
// ============================================

/**
 * 显示 Toast 提示
 */
function showToast(message, type = 'info') {
    // 移除现有的 toast
    const existing = document.querySelector('.toast');
    if (existing) {
        existing.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // 3秒后自动消失
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

/**
 * 处理步行速度变化
 */
function handleSpeedChange(e) {
    const speed = parseFloat(e.target.value);
    state.walkSpeed = speed;
    
    // 更新显示
    document.getElementById('speed-display').textContent = speed.toFixed(1);
    
    // 计算15分钟步行距离
    const distance = Math.round(speed * 1000 / 60 * 15);
    document.getElementById('walk-distance').textContent = distance;
    
    // 更新预设按钮状态
    document.querySelectorAll('.speed-preset').forEach(btn => {
        btn.classList.remove('active');
        if (parseFloat(btn.dataset.speed) === speed) {
            btn.classList.add('active');
        }
    });
}

/**
 * 处理速度预设按钮点击
 */
function handleSpeedPreset(e) {
    const speed = parseFloat(e.target.dataset.speed);
    state.walkSpeed = speed;
    
    // 更新滑块
    const slider = document.getElementById('walk-speed');
    slider.value = speed;
    
    // 更新显示
    document.getElementById('speed-display').textContent = speed.toFixed(1);
    const distance = Math.round(speed * 1000 / 60 * 15);
    document.getElementById('walk-distance').textContent = distance;
    
    // 更新按钮状态
    document.querySelectorAll('.speed-preset').forEach(btn => {
        btn.classList.remove('active');
    });
    e.target.classList.add('active');
}

/**
 * 处理 POI 分类筛选
 */
function handleCategoryFilter(e) {
    const checkbox = e.target;
    const label = checkbox.closest('.filter-checkbox');
    const category = label.dataset.category;
    
    if (category) {
        state.categoryFilters[category] = checkbox.checked;
        
        // 重新渲染 POI（使用缓存的 GeoJSON 对象）
        if (state.currentPOIsGeoJSON) {
            renderPOIs(state.currentPOIsGeoJSON);
        }
        
        // 更新全选复选框状态
        updateFilterAllCheckbox();
    }
}

/**
 * 处理全选/取消全选
 */
function handleFilterAll(e) {
    const checked = e.target.checked;
    
    // 更新所有分类筛选状态
    Object.keys(state.categoryFilters).forEach(cat => {
        state.categoryFilters[cat] = checked;
    });
    
    // 更新所有复选框
    document.querySelectorAll('#poi-filter-list .filter-checkbox input').forEach(checkbox => {
        checkbox.checked = checked;
    });
    
    // 重新渲染 POI（使用缓存的 GeoJSON 对象）
    if (state.currentPOIsGeoJSON) {
        renderPOIs(state.currentPOIsGeoJSON);
    }
}

/**
 * 更新全选复选框状态
 */
function updateFilterAllCheckbox() {
    const allChecked = Object.values(state.categoryFilters).every(v => v);
    const noneChecked = Object.values(state.categoryFilters).every(v => !v);
    const filterAllCheckbox = document.getElementById('filter-all');
    
    if (filterAllCheckbox) {
        filterAllCheckbox.checked = allChecked;
        filterAllCheckbox.indeterminate = !allChecked && !noneChecked;
    }
}

// ============================================
// 地图交互
// ============================================

/**
 * 处理地图点击
 */
async function handleMapClick(e) {
    const { lat, lng } = e.latlng;

    // 框外没有路网，算出来的等时圈会从一个无关的节点起算，所以直接挡掉
    if (rejectOutside(lat, lng, '该位置')) return;

    // 更新选中位置
    state.selectedLocation = { lat, lng };
    updateLocationDisplay(lat, lng);
    
    // 更新标记
    updateMarker(lat, lng);
    
    // 执行分析
    await analyzePoint(lng, lat);
}

/**
 * 更新位置显示
 */
function updateLocationDisplay(lat, lng) {
    const container = document.getElementById('current-location');
    container.innerHTML = `
        <p><strong>经度:</strong> ${lng.toFixed(6)}</p>
        <p><strong>纬度:</strong> ${lat.toFixed(6)}</p>
    `;
}

/**
 * 更新地图标记
 */
function updateMarker(lat, lng) {
    if (state.currentMarker) {
        state.map.removeLayer(state.currentMarker);
    }
    
    state.currentMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'custom-marker',
            html: '<div style="background:#e74c3c;width:20px;height:20px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        })
    }).addTo(state.map);
}

// ============================================
// 进度日志管理
// ============================================

/**
 * 进度日志状态
 */
const progressState = {
    startTime: null,
    items: []
};

/**
 * 显示进度面板
 */
function showProgress() {
    console.log('[Progress] showProgress called');
    const overlay = document.getElementById('progress-overlay');
    const log = document.getElementById('progress-log');
    
    if (overlay && log) {
        overlay.classList.add('active');
        log.innerHTML = '';
        progressState.startTime = Date.now();
        progressState.items = [];
        console.log('[Progress] Panel shown');
    } else {
        console.error('[Progress] Panel elements not found!');
    }
}

/**
 * 隐藏进度面板
 */
function hideProgress() {
    const overlay = document.getElementById('progress-overlay');
    
    // 延迟隐藏，让用户看到最终状态
    setTimeout(() => {
        if (overlay) overlay.classList.remove('active');
    }, 1500);
}

/**
 * 添加进度日志项
 * @param {string} message - 日志消息
 * @param {string} status - 状态: 'loading' | 'completed' | 'error'
 */
function addProgressItem(message, status = 'loading') {
    const log = document.getElementById('progress-log');
    if (!log) return;
    
    const elapsed = progressState.startTime ? 
        ((Date.now() - progressState.startTime) / 1000).toFixed(1) : '0.0';
    
    // 将之前的 loading 项标记为 completed，并更新其时间
    const prevItems = log.querySelectorAll('.progress-item.current');
    prevItems.forEach(item => {
        item.classList.remove('current');
        item.classList.add('completed');
        const icon = item.querySelector('.progress-icon');
        if (icon) {
            icon.classList.remove('loading');
            icon.textContent = '✓';
        }
        // 更新时间为当前时间
        const timeEl = item.querySelector('.progress-time');
        if (timeEl) {
            timeEl.textContent = elapsed + 's';
        }
    });
    
    // 创建新日志项
    const item = document.createElement('div');
    item.className = `progress-item ${status === 'loading' ? 'current' : status}`;
    
    let icon = '▶';
    if (status === 'completed') icon = '✓';
    if (status === 'error') icon = '✗';
    
    item.innerHTML = `
        <span class="progress-icon ${status === 'loading' ? 'loading' : ''}">${icon}</span>
        <span class="progress-text">${message}</span>
        <span class="progress-time">${elapsed}s</span>
    `;
    
    log.appendChild(item);
    
    // 自动滚动到底部
    log.scrollTop = log.scrollHeight;
    
    progressState.items.push({ message, status, elapsed });
}

/**
 * 更新最后一项的状态
 */
function updateLastProgress(status) {
    const log = document.getElementById('progress-log');
    if (!log) return;
    
    const elapsed = progressState.startTime ? 
        ((Date.now() - progressState.startTime) / 1000).toFixed(1) : '0.0';
    
    const lastItem = log.querySelector('.progress-item:last-child');
    if (lastItem) {
        lastItem.classList.remove('current', 'loading');
        lastItem.classList.add(status);
        const icon = lastItem.querySelector('.progress-icon');
        if (icon) {
            icon.classList.remove('loading');
            icon.textContent = status === 'completed' ? '✓' : '✗';
        }
        // 更新完成时间
        const timeEl = lastItem.querySelector('.progress-time');
        if (timeEl) {
            timeEl.textContent = elapsed + 's';
        }
    }
}

// ============================================
// API 调用
// ============================================

/**
 * 延迟函数，让浏览器有机会重绘UI
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 请求去重：存储当前正在进行的分析请求
let currentAnalysisController = null;

/**
 * 分析指定点
 */
async function analyzePoint(lng, lat) {
    // 取消之前未完成的请求
    if (currentAnalysisController) {
        currentAnalysisController.abort();
        currentAnalysisController = null;
    }
    
    // 显示进度面板
    showProgress();
    addProgressItem('开始分析坐标点...');
    await delay(50); // 让UI更新
    
    try {
        // 设置超时控制（60秒，新算法需要更多时间）
        currentAnalysisController = new AbortController();
        const timeoutId = setTimeout(() => currentAnalysisController?.abort(), 60000);
        
        addProgressItem('计算步行可达范围（等时圈）...');
        
        const response = await fetch(`${CONFIG.apiBase}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                lng, 
                lat, 
                time_threshold: 15,
                walk_speed: state.walkSpeed  // 使用用户配置的速度
            }),
            signal: currentAnalysisController.signal
        });
        
        clearTimeout(timeoutId);
        currentAnalysisController = null;
        
        updateLastProgress('completed');
        addProgressItem('正在解析服务器响应...');
        await delay(30);
        
        // 422 是后端的范围守卫：起点不在数据里，或附近没有可起算的路网节点。
        // 这不是故障，给用户一句人话，不要走通用报错。
        if (response.status === 422) {
            const detail = await response.json().catch(() => ({}));
            hideProgress();
            showToast(detail.message || '该点无法分析', 'error');
            flashCoverage();
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        updateLastProgress('completed');
        addProgressItem('渲染等时圈...');
        await delay(30);
        
        // 缓存 POI 数据
        // currentPOIsGeoJSON: 完整的 GeoJSON 对象，用于 renderPOIs
        // currentPOIs: features 数组，用于 renderPOISourceStats
        state.currentPOIsGeoJSON = result.pois;
        state.currentPOIs = result.pois && result.pois.features ? result.pois.features : [];
        
        // 渲染道路网络（在等时圈下面）
        if (result.roads) {
            renderRoads(result.roads);
        }
        
        // 渲染等时圈
        renderIsochrone(result.isochrone);
        
        updateLastProgress('completed');
        addProgressItem(`渲染 ${state.currentPOIs.length} 个设施点...`);
        await delay(30);
        
        // 渲染POI
        renderPOIs(result.pois);
        
        updateLastProgress('completed');
        addProgressItem('计算评估得分...');
        await delay(30);
        
        // 渲染评估结果
        renderEvaluationResult(result);
        
        updateLastProgress('completed');
        addProgressItem('分析完成！', 'completed');
        
        // 隐藏进度面板
        hideProgress();
        
    } catch (error) {
        console.error('Analysis failed:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        
        // 更新进度显示错误
        updateLastProgress('error');
        
        // 根据错误类型显示不同提示
        if (error.name === 'AbortError') {
            addProgressItem('请求超时（60秒），请重试', 'error');
            showError('请求超时，服务器响应时间过长，请稍后重试');
        } else if (error.message && error.message.includes('Failed to fetch')) {
            addProgressItem('网络连接失败', 'error');
            showError('网络连接失败，请检查网络');
        } else {
            addProgressItem(`错误: ${error.message || '未知错误'}`, 'error');
            showError('分析失败: ' + (error.message || '请重试'));
        }
        
        // 开发模式：使用模拟数据
        if (window.location.hostname === 'localhost') {
            renderMockResult(lng, lat);
        }
    }
}

// ============================================
// 渲染函数
// ============================================

/**
 * 渲染等时圈（分层渲染，支持开关控制）
 */
function renderIsochrone(geojson) {
    state.isochroneLayer.clearLayers();
    
    // 清空各分层
    state.isochroneLayers = { 5: null, 10: null, 15: null };
    
    if (!geojson || !geojson.features) return;
    
    // 缓存数据用于后续开关控制
    state.currentIsochroneData = geojson;
    
    // 按照 15 -> 10 -> 5 的顺序添加（15分钟在最底层）
    const order = [15, 10, 5];
    
    order.forEach(targetMinutes => {
        const feature = geojson.features.find(f => 
            f.properties.type === 'isochrone' && f.properties.minutes === targetMinutes
        );
        
        if (feature) {
            const style = CONFIG.isochroneStyles[targetMinutes];
            const layer = L.geoJSON(feature, {
                style: () => style
            });
            
            // 存储图层引用
            state.isochroneLayers[targetMinutes] = layer;
            
            // 根据可见性决定是否添加到地图
            if (state.isochroneVisibility[targetMinutes]) {
                layer.addTo(state.isochroneLayer);
            }
        }
    });
}

/**
 * 处理等时圈图层开关
 */
function handleIsochroneToggle(e) {
    const checkbox = e.target;
    const id = checkbox.id;
    const minutes = parseInt(id.replace('isochrone-', ''));
    
    if (isNaN(minutes)) return;
    
    state.isochroneVisibility[minutes] = checkbox.checked;
    
    const layer = state.isochroneLayers[minutes];
    if (!layer) return;
    
    if (checkbox.checked) {
        // 添加图层
        layer.addTo(state.isochroneLayer);
    } else {
        // 移除图层
        state.isochroneLayer.removeLayer(layer);
    }
}

/**
 * 渲染道路网络
 */
function renderRoads(roadsGeoJSON) {
    state.roadsLayer.clearLayers();
    
    if (!roadsGeoJSON || !roadsGeoJSON.features) return;
    
    // 缓存数据
    state.currentRoadsData = roadsGeoJSON;
    
    // 创建道路图层
    const roadsLayerGeoJSON = L.geoJSON(roadsGeoJSON, {
        style: (feature) => {
            const cost = feature.properties?.cost || 0;
            // 根据到达时间渐变颜色
            let color = '#4a5568';
            let opacity = 0.6;
            
            if (cost <= 5) {
                color = '#22c55e'; // 5分钟内 - 绿色
                opacity = 0.8;
            } else if (cost <= 10) {
                color = '#3b82f6'; // 10分钟内 - 蓝色
                opacity = 0.7;
            } else {
                color = '#f97316'; // 15分钟内 - 橙色
                opacity = 0.5;
            }
            
            return {
                color: color,
                weight: 2,
                opacity: opacity
            };
        }
    });
    
    // 根据可见性添加
    if (state.roadsVisible) {
        roadsLayerGeoJSON.addTo(state.roadsLayer);
    }
    
    // 保存图层引用
    state.roadsLayerGeoJSON = roadsLayerGeoJSON;
}

/**
 * 处理道路网络开关
 */
function handleRoadsToggle(e) {
    state.roadsVisible = e.target.checked;
    
    if (!state.roadsLayerGeoJSON) return;
    
    if (state.roadsVisible) {
        state.roadsLayerGeoJSON.addTo(state.roadsLayer);
    } else {
        state.roadsLayer.clearLayers();
    }
}

/**
 * 渲染 POI（支持分类筛选）
 */
function renderPOIs(geojson) {
    state.poiLayer.clearLayers();
    
    if (!geojson || !geojson.features) return;
    
    geojson.features.forEach(feature => {
        if (feature.properties.type === 'poi') {
            const { category, name, sub_type } = feature.properties;
            
            // 检查该分类是否被筛选显示
            if (!state.categoryFilters[category]) {
                return; // 跳过被隐藏的分类
            }
            
            const [lng, lat] = feature.geometry.coordinates;
            
            const color = CONFIG.categoryColors[category] || '#666';
            const icon = CONFIG.categoryIcons[category] || '📍';
            
            const marker = L.circleMarker([lat, lng], {
                radius: 6,
                fillColor: color,
                color: '#fff',
                weight: 2,
                fillOpacity: 0.8
            });
            
            // 计算距离和步行时间
            let distanceHtml = '';
            if (state.selectedLocation) {
                const distance = calculateDistance(
                    state.selectedLocation.lat, 
                    state.selectedLocation.lng, 
                    lat, lng
                );
                const walkTime = (distance / (state.walkSpeed * 1000 / 60)).toFixed(1);
                distanceHtml = `
                    <div class="poi-distance">
                        <span class="distance-value">${Math.round(distance)}米</span>
                        <span class="walk-time">🚶 约${walkTime}分钟</span>
                    </div>
                `;
            }
            
            // 改进的 POI 详情卡片
            marker.bindPopup(`
                <div class="poi-popup">
                    <div class="poi-popup-header" style="background: linear-gradient(135deg, ${color}, ${adjustColor(color, -20)});">
                        <h4>
                            <span class="poi-icon">${icon}</span>
                            ${name || '未命名设施'}
                        </h4>
                    </div>
                    <div class="poi-popup-body">
                        <span class="poi-category" style="background: ${color};">${getCategoryName(category)}</span>
                        <div class="poi-info">
                            <div class="poi-info-item">
                                <span class="label">类型</span>
                                <span class="value">${getSubTypeName(sub_type)}</span>
                            </div>
                            <div class="poi-info-item">
                                <span class="label">坐标</span>
                                <span class="value">${lng.toFixed(4)}, ${lat.toFixed(4)}</span>
                            </div>
                        </div>
                        ${distanceHtml}
                    </div>
                </div>
            `, { maxWidth: 280 });
            
            marker.addTo(state.poiLayer);
        }
    });
    
    // 更新 POI 计数显示
    updatePOICount();
}

/**
 * 调整颜色深浅
 */
function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const num = parseInt(hex, 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
    const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
    return `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
}

/**
 * 更新 POI 计数显示
 */
function updatePOICount() {
    let visibleCount = 0;
    state.poiLayer.eachLayer(() => visibleCount++);
    
    // 如果有计数显示元素，更新它
    const countEl = document.getElementById('poi-count');
    if (countEl) {
        countEl.textContent = visibleCount;
    }
}

/**
 * 计算两点间距离（米）
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // 地球半径（米）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

/**
 * 渲染评价结果
 */
function renderEvaluationResult(result) {
    // 缓存结果（用于导出）
    state.currentResult = result;
    
    // 显示结果面板
    document.getElementById('result-panel').style.display = 'block';
    
    // 移动端：分析完成后自动关闭侧边栏，让用户看到地图
    if (typeof window.closeSidebarAfterAnalysis === 'function') {
        window.closeSidebarAfterAnalysis();
    }
    
    // 总分
    const scoreEl = document.getElementById('total-score');
    scoreEl.textContent = result.total_score ? result.total_score.toFixed(1) : '--';
    
    // 等级
    const gradeEl = document.getElementById('grade-badge');
    gradeEl.textContent = result.grade || '-';
    gradeEl.className = `grade-badge grade-${result.grade}`;
    
    // 摘要
    document.getElementById('result-summary').textContent = result.summary || '';
    
    // 分类评分
    renderCategoryScores(result.category_scores || []);
    
    // 渲染雷达图
    renderRadarChart(result.category_scores || []);
    
    // 建议
    renderSuggestions(result.suggestions || []);
}

/**
 * 渲染分类评分
 */
function renderCategoryScores(scores) {
    const container = document.getElementById('category-scores');
    
    // 从实际 POI 数据统计各分类数量
    const categoryPOICounts = {};
    if (state.currentPOIs && Array.isArray(state.currentPOIs)) {
        state.currentPOIs.forEach(feature => {
            const cat = feature.properties?.category || 'other';
            categoryPOICounts[cat] = (categoryPOICounts[cat] || 0) + 1;
        });
    }
    
    container.innerHTML = scores.map(cs => {
        const icon = CONFIG.categoryIcons[cs.category] || '📍';
        const color = CONFIG.categoryColors[cs.category] || '#666';
        const score = cs.score || 0;
        // 使用实际 POI 数量，而不是后端返回的 poi_count
        const poiCount = categoryPOICounts[cs.category] || 0;
        
        return `
            <div class="category-item">
                <span class="category-icon">${icon}</span>
                <div class="category-info">
                    <div class="category-name">${cs.name} <span class="poi-count-badge">(${poiCount}处)</span></div>
                    <div class="category-bar">
                        <div class="category-bar-fill" style="width: ${score}%; background: ${color};"></div>
                    </div>
                </div>
                <span class="category-score-value">${score.toFixed(0)}</span>
            </div>
        `;
    }).join('');
    
    // 添加 POI 来源统计
    renderPOISourceStats();
}

/**
 * 渲染 POI 来源统计
 */
function renderPOISourceStats() {
    // 确保 currentPOIs 是数组
    if (!state.currentPOIs || !Array.isArray(state.currentPOIs) || state.currentPOIs.length === 0) {
        return;
    }
    
    // 统计各来源的 POI 数量
    let osmCount = 0;
    let amapCount = 0;
    
    state.currentPOIs.forEach(feature => {
        // GeoJSON feature 的属性在 properties 中
        const props = feature.properties || feature;
        if (props.source === 'amap') {
            amapCount++;
        } else {
            osmCount++; // 默认是 OSM/本地数据
        }
    });
    
    const total = osmCount + amapCount;
    
    // 查找或创建统计容器
    let statsContainer = document.getElementById('poi-source-stats');
    if (!statsContainer) {
        statsContainer = document.createElement('div');
        statsContainer.id = 'poi-source-stats';
        statsContainer.className = 'poi-source-stats';
        document.getElementById('category-scores').appendChild(statsContainer);
    }
    
    statsContainer.innerHTML = `
        <div class="source-stat-item">
            <span class="source-icon">🗺️</span>
            <span class="source-label">本地数据</span>
            <span class="source-count">${osmCount}</span>
        </div>
        <div class="source-stat-item">
            <span class="source-icon">🔵</span>
            <span class="source-label">高德地图</span>
            <span class="source-count">${amapCount}</span>
        </div>
        <div class="source-stat-total">
            共 ${total} 个设施
        </div>
    `;
}

/**
 * 渲染建议
 */
function renderSuggestions(suggestions) {
    const list = document.getElementById('suggestion-list');
    list.innerHTML = suggestions.map(s => `<li>${s}</li>`).join('');
}

// ============================================
// 辅助函数
// ============================================

/**
 * 显示/隐藏加载状态
 */
function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
}

/**
 * 显示错误消息（使用Toast通知）
 */
function showError(message) {
    // 创建或复用Toast容器
    let toast = document.getElementById('error-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'error-toast';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #c53030;
            color: white;
            padding: 12px 24px;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            opacity: 0;
            transition: opacity 0.3s;
        `;
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.style.opacity = '1';
    
    // 3秒后自动隐藏
    setTimeout(() => {
        toast.style.opacity = '0';
    }, 3000);
}

/**
 * 获取分类名称
 */
function getCategoryName(code) {
    const names = {
        medical: '医疗卫生',
        education: '教育设施',
        elderly: '养老服务',
        commerce: '商业服务',
        culture: '文化体育',
        public: '公共管理',
        transport: '交通设施',
        child: '托幼托育'
    };
    return names[code] || code;
}

/**
 * 获取子类型名称
 */
function getSubTypeName(code) {
    const names = {
        // 医疗卫生
        community_health: '社区卫生服务中心/站',
        hospital: '医院',
        pharmacy: '药店',
        // 教育设施
        kindergarten: '幼儿园',
        primary: '小学',
        secondary: '初中',
        // 养老服务
        elderly_center: '社区养老服务中心',
        daycare: '日间照料中心',
        elderly_activity: '老年活动室',
        // 商业服务
        market: '菜市场/生鲜超市',
        supermarket: '综合超市',
        convenience: '便利店',
        restaurant: '餐饮服务',
        // 文化体育
        culture_center: '文化活动中心',
        sports_field: '健身场地/球场',
        park: '公园绿地',
        library: '图书室/阅览室',
        // 公共管理
        community_service: '社区服务中心',
        police: '派出所/警务室',
        bank: '银行网点',
        post: '邮政服务',
        // 交通设施
        bus_stop: '公交站点',
        metro: '轨道交通站',
        parking: '公共停车场',
        bike_parking: '非机动车停车',
        // 托幼托育
        nursery: '托儿所/托育机构',
        playground: '儿童游乐设施'
    };
    return names[code] || code;
}

/**
 * 开发模式：模拟结果
 */
function renderMockResult(lng, lat) {
    // 模拟等时圈（简单圆形）
    state.isochroneLayer.clearLayers();
    
    [15, 10, 5].forEach(minutes => {
        const radius = minutes * 83.33; // 约 5km/h 步行速度
        const style = CONFIG.isochroneStyles[minutes];
        
        L.circle([lat, lng], {
            radius: radius,
            ...style
        }).addTo(state.isochroneLayer);
    });
    
    // 模拟评分结果
    const mockResult = {
        total_score: 72.5,
        grade: 'B',
        summary: '良好：生活圈配套较为完善，基本满足日常生活需求',
        category_scores: [
            { category: 'medical', name: '医疗卫生', score: 80, poi_count: 5 },
            { category: 'education', name: '教育设施', score: 75, poi_count: 3 },
            { category: 'commerce', name: '商业服务', score: 85, poi_count: 8 },
            { category: 'culture', name: '文化体育', score: 60, poi_count: 2 },
            { category: 'public', name: '公共服务', score: 70, poi_count: 4 },
            { category: 'transport', name: '交通设施', score: 90, poi_count: 6 },
            { category: 'elderly', name: '养老服务', score: 45, poi_count: 1 },
            { category: 'child', name: '托幼托育', score: 55, poi_count: 2 }
        ],
        suggestions: [
            '【文化体育】设施覆盖不足（得分60），建议增设相关配套设施',
            '【养老服务】设施覆盖不足（得分45），建议增设相关配套设施'
        ]
    };
    
    renderEvaluationResult(mockResult);
}

// ============================================
// 雷达图功能
// ============================================

/**
 * 初始化雷达图
 */
function initRadarChart() {
    const chartDom = document.getElementById('radar-chart');
    if (chartDom && typeof echarts !== 'undefined') {
        // 确保容器有正确尺寸后再初始化
        setTimeout(() => {
            state.radarChart = echarts.init(chartDom);
            
            // 监听窗口大小变化
            window.addEventListener('resize', () => {
                if (state.radarChart) {
                    state.radarChart.resize();
                }
            });
        }, 100);
    }
}

/**
 * 渲染雷达图
 */
function renderRadarChart(categoryScores) {
    // 如果图表未初始化，延迟重试
    if (!state.radarChart) {
        const chartDom = document.getElementById('radar-chart');
        if (chartDom && typeof echarts !== 'undefined') {
            state.radarChart = echarts.init(chartDom);
        } else {
            return;
        }
    }
    
    if (!categoryScores || categoryScores.length === 0) {
        return;
    }
    
    // 强制重新计算尺寸
    state.radarChart.resize();
    
    // 分类名称简称映射
    const shortNames = {
        '医疗卫生': '医疗',
        '教育设施': '教育',
        '养老服务': '养老',
        '商业服务': '商服',
        '文化体育': '文体',
        '公共管理': '公管',
        '交通设施': '交通',
        '托幼托育': '幼托'
    };
    
    // 准备雷达图数据 - 黑白专业风格，使用简称
    const indicators = categoryScores.map(cs => ({
        name: shortNames[cs.name] || cs.name,
        max: 100
    }));
    
    const values = categoryScores.map(cs => cs.score || 0);
    
    // 雷达图配置 - 黑白专业风格
    const option = {
        tooltip: {
            trigger: 'item',
            backgroundColor: 'rgba(50, 50, 50, 0.9)',
            borderColor: '#333',
            textStyle: {
                color: '#fff'
            },
            formatter: function(params) {
                let result = `<strong>各类设施评分</strong><br/>`;
                categoryScores.forEach((cs, i) => {
                    result += `${cs.name}: <strong>${values[i].toFixed(0)}</strong>分<br/>`;
                });
                return result;
            }
        },
        radar: {
            center: ['50%', '50%'],
            radius: '60%',
            indicator: indicators,
            shape: 'polygon',
            splitNumber: 4,
            axisName: {
                color: '#333',
                fontSize: 13,
                fontWeight: 'bold',
                fontWeight: 'normal',
                padding: [3, 5]
            },
            splitLine: {
                lineStyle: {
                    color: '#ccc',
                    width: 1
                }
            },
            splitArea: {
                show: true,
                areaStyle: {
                    color: ['#fff', '#f5f5f5', '#fff', '#f5f5f5']
                }
            },
            axisLine: {
                lineStyle: {
                    color: '#bbb'
                }
            }
        },
        series: [{
            name: '生活圈评分',
            type: 'radar',
            data: [{
                value: values,
                name: '评分',
                symbol: 'circle',
                symbolSize: 5,
                lineStyle: {
                    color: '#333',
                    width: 2
                },
                areaStyle: {
                    color: 'rgba(100, 100, 100, 0.2)'
                },
                itemStyle: {
                    color: '#333',
                    borderColor: '#fff',
                    borderWidth: 2
                }
            }]
        }]
    };
    
    state.radarChart.setOption(option, true);
}

// ============================================
// 辅助函数
// ============================================

/**
 * 获取雷达图两字简称
 */
function getRadarShortName(name) {
    const shortNames = {
        '医疗卫生': '医疗',
        '教育设施': '教育',
        '养老服务': '养老',
        '商业服务': '商服',
        '文化体育': '文体',
        '公共管理': '公管',
        '交通设施': '交通',
        '托幼托育': '幼托'
    };
    return shortNames[name] || name;
}

// ============================================
// 城市选择器
// ============================================

/**
 * 初始化区域选择器
 *
 * 原来是三个城市的下拉框。现在只有一块区域真的有数据，
 * 另外两个保留为不可选项，标注原因。
 */
function initCitySelector() {
    const selector = document.getElementById('city-selector');
    if (!selector) return;

    const cov = CONFIG.coverage;
    const opts = [`<option value="coverage" selected>${cov.name}</option>`]
        .concat(UNAVAILABLE_CITIES.map(n => `<option disabled>${n}（暂无数据）</option>`));
    selector.innerHTML = opts.join('');

    // 只剩一个可选项，交互上没有意义，但保留控件让"少了什么"看得见
    selector.disabled = UNAVAILABLE_CITIES.length === 0;

    selector.addEventListener('change', () => {
        selector.value = 'coverage';
    });

    updateCityInfo();
}

/**
 * 画出可分析区域：区域外压暗 + 区域轮廓
 *
 * 路网是按矩形裁的，所以这个矩形是真实边界而非外接近似。
 */
function updateCityBoundsRect() {
    const c = CONFIG.coverage;
    const rect = [[c.min_lat, c.min_lng], [c.max_lat, c.max_lng]];

    if (state.coverageMask) state.map.removeLayer(state.coverageMask);
    if (state.coverageRect) state.map.removeLayer(state.coverageRect);

    // 外环取全球、内环取数据矩形，SVG 的 even-odd 填充规则会把内环挖空，
    // 于是「区域外」被压暗，「区域内」保持清晰。
    // 纬度只能取到 ±85：Web 墨卡托在两极是发散的，写 ±90 会投影出一个
    // 极大的 Y 值，SVG 渲染会出问题。
    const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    const hole = [
        [c.min_lat, c.min_lng], [c.min_lat, c.max_lng],
        [c.max_lat, c.max_lng], [c.max_lat, c.min_lng]
    ];
    state.coverageMask = L.polygon([world, hole], {
        stroke: false,
        fillColor: '#0f172a',
        fillOpacity: 0.45,
        interactive: false
    }).addTo(state.map);

    state.coverageRect = L.rectangle(rect, {
        color: '#2563eb',
        weight: 2.5,
        fillOpacity: 0,
        interactive: false
    }).addTo(state.map);

    // 标签贴在矩形上边缘外侧。直接 bindTooltip 到矩形会挂在它的几何中心，
    // 而中心正是用户最想点的地方，permanent 标签杵在那儿碍事。
    if (state.coverageTip) state.map.removeLayer(state.coverageTip);
    state.coverageTip = L.tooltip({
        permanent: true,
        direction: 'top',
        className: 'coverage-label',
        interactive: false
    })
        .setContent('可分析区域')
        .setLatLng([c.max_lat, (c.min_lng + c.max_lng) / 2])
        .addTo(state.map);
}

/**
 * 更新区域信息显示
 */
function updateCityInfo() {
    const cov = CONFIG.coverage;
    const infoEl = document.getElementById('city-info');
    if (!infoEl) return;
    const w = cov.span_lng_km ? cov.span_lng_km.toFixed(1) : '?';
    const h = cov.span_lat_km ? cov.span_lat_km.toFixed(1) : '?';
    infoEl.innerHTML =
        `${cov.description || ''}<br>` +
        `<span class="coverage-stats">约 ${w}×${h} km · ${cov.ways} 条道路 · ${cov.pois} 个 POI</span><br>` +
        `<span class="coverage-hint">仅蓝框内可分析，框外无路网数据</span>`;
}

/**
 * 清除分析结果
 */
function clearAnalysis() {
    // 清除标记
    if (state.currentMarker) {
        state.map.removeLayer(state.currentMarker);
        state.currentMarker = null;
    }
    
    // 清除图层
    state.isochroneLayer.clearLayers();
    state.poiLayer.clearLayers();
    
    // 重置状态
    state.selectedLocation = null;
    state.currentPOIs = null;
    state.currentResult = null;
    
    // 隐藏结果面板
    document.getElementById('result-panel').style.display = 'none';
    document.getElementById('current-location').innerHTML = '<p class="placeholder">请在地图上点击选择位置</p>';
}
