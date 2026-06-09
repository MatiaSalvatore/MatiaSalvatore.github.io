// --- Estado Global de la Aplicación ---
const appState = {
    files: [],
    selectedFile: "",
    data: {
        historial: [],
        top20: []
    },
    // Paginación y Filtrado del Historial
    filteredHistorial: [],
    historyPage: 1,
    historyPerPage: 15,
    historySortColumn: "Sorteo",
    historySortAscending: false,
    // Instancias de Gráficos (para destruirlas antes de recrear)
    charts: {},
    // Polling del Scraper
    scrapeInterval: null,
    isScraping: false
};

// --- Configuración de Gráficos (Estilos Globales de Chart.js) ---
Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Outfit', sans-serif";

// --- Funciones de Utilidad ---
function showLoader(message = "Cargando datos...") {
    document.getElementById("loadingText").innerText = message;
    document.getElementById("loadingOverlay").classList.add("active");
}

function hideLoader() {
    document.getElementById("loadingOverlay").classList.remove("active");
}

function parseDateStr(str) {
    if (!str) return new Date(0);
    // Asume formato dd-mm-yyyy o dd/mm/yyyy
    const cleanStr = str.replace(/\//g, "-");
    const parts = cleanStr.split("-");
    if (parts.length === 3) {
        return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    }
    return new Date(str);
}

// Helper para formatear números con ceros a la izquierda
function padZero(num) {
    return num.toString().padStart(2, '0');
}

// --- Gestión de Pestañas (Tabs) ---
function initTabs() {
    const tabButtons = document.querySelectorAll(".tab-btn");
    tabButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            // Desactivar pestañas activas
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            
            // Activar la nueva pestaña
            btn.classList.add("active");
            const tabId = btn.getAttribute("data-tab");
            document.getElementById(tabId).classList.add("active");
            
            // Acciones adicionales al cambiar a ciertas pestañas
            if (tabId === "tab-dashboard") {
                // Forzar redibujado de gráficos para corregir anchos responsivos
                Object.values(appState.charts).forEach(chart => chart.resize());
            }
        });
    });
}

// --- Inicialización: Cargar Lista de Archivos ---
async function loadFilesList() {
    try {
        const response = await fetch("/api/files");
        if (!response.ok) throw new Error("No se pudo obtener la lista de archivos");
        appState.files = await response.json();
        
        const select = document.getElementById("excelFileSelect");
        select.innerHTML = "";
        
        appState.files.forEach(file => {
            const option = document.createElement("option");
            option.value = file;
            option.textContent = file;
            select.appendChild(option);
        });
        
        // Seleccionar el primero por defecto
        if (appState.files.length > 0) {
            appState.selectedFile = appState.files[0];
            select.value = appState.selectedFile;
            document.getElementById("targetScrapeFile").value = appState.selectedFile;
            await loadFileData(appState.selectedFile);
        }
    } catch (error) {
        console.error("Error cargando archivos:", error);
        alert("Error al conectar con el servidor local. Asegúrate de ejecutar app.py");
    }
}

// --- Cargar los datos de un archivo Excel específico ---
async function loadFileData(fileName) {
    showLoader(`Leyendo datos de ${fileName}...`);
    try {
        const response = await fetch(`/api/data?file=${encodeURIComponent(fileName)}`);
        if (!response.ok) throw new Error("No se pudieron cargar los datos del archivo");
        const resData = await response.json();
        
        appState.data.historial = resData.historial;
        appState.data.top20 = resData.top20;
        
        // Inicializar filtros e historial
        appState.filteredHistorial = [...appState.data.historial];
        appState.historyPage = 1;
        
        // Actualizar vistas
        renderDashboard();
        renderTop20MonthSelector();
        applyHistorySorting();
        renderHistoryTable();
        
        // Restablecer simulador
        resetSimulator();
        
    } catch (error) {
        console.error(error);
        alert(`Error al procesar el archivo Excel: ${error.message}`);
    } finally {
        hideLoader();
    }
}

// --- PESTAÑA: DASHBOARD GENERAL ---
function renderDashboard() {
    const hist = appState.data.historial;
    if (hist.length === 0) {
        document.getElementById("metric-total-value").textContent = "0";
        document.getElementById("metric-last-value").textContent = "-";
        document.getElementById("metric-last-date").textContent = "Fecha: -";
        document.getElementById("metric-hot-value").textContent = "-";
        document.getElementById("metric-cold-value").textContent = "-";
        return;
    }
    
    // 1. Métricas Básicas
    document.getElementById("metric-total-value").textContent = hist.length;
    
    const ultimoSorteo = hist[0];
    document.getElementById("metric-last-value").textContent = ultimoSorteo.Sorteo;
    document.getElementById("metric-last-date").textContent = `Fecha: ${ultimoSorteo.Fecha}`;
    
    // 2. Calcular Frecuencias Globales e Históricas (00 - 99)
    const frecuencias = Array(100).fill(0);
    let totalNumerosExtraidos = 0;
    let parCount = 0;
    let imparCount = 0;
    const decenasCount = Array(10).fill(0); // 0-9, 10-19, etc.
    
    // Registrar el último sorteo de cada número para calcular el retraso (delay)
    // El historial ya viene ordenado por sorteo de mayor a menor (hist[0] es el más nuevo)
    const delayMap = Array(100).fill(null);
    
    hist.forEach((sorteo, sIdx) => {
        // Recorrer las 10 posiciones de bolillas
        for (let p = 1; p <= 10; p++) {
            const val = sorteo[`Pos ${p}`];
            if (val !== undefined && val !== null && val !== "") {
                const num = parseInt(val);
                if (num >= 0 && num <= 99) {
                    // Solo contar frecuencias globales
                    frecuencias[num]++;
                    totalNumerosExtraidos++;
                    
                    // Contar pares vs impares
                    if (num % 2 === 0) parCount++;
                    else imparCount++;
                    
                    // Decenas
                    const decena = Math.floor(num / 10);
                    decenasCount[decena]++;
                    
                    // Registrar delay
                    if (delayMap[num] === null) {
                        delayMap[num] = sIdx; // Cantidad de sorteos desde el último avistamiento
                    }
                }
            }
        }
    });
    
    // Guardar frecuencias globales y top números más calientes/fríos
    const freqList = frecuencias.map((freq, num) => ({ num, freq }));
    
    // Ordenar por frecuencia descendente
    const sortedFreq = [...freqList].sort((a, b) => b.freq - a.freq);
    const hotNum = sortedFreq[0];
    
    // Ordenar por frecuencia ascendente (excluyendo los que nunca salieron si corresponde, pero aquí todos suelen salir)
    const coldNum = sortedFreq[sortedFreq.length - 1];
    
    document.getElementById("metric-hot-value").textContent = padZero(hotNum.num);
    document.getElementById("metric-hot-freq").textContent = `Frecuencia: ${hotNum.freq} veces`;
    
    document.getElementById("metric-cold-value").textContent = padZero(coldNum.num);
    document.getElementById("metric-cold-freq").textContent = `Frecuencia: ${coldNum.freq} veces`;
    
    // Guardar los top 15 números más calientes globales para darles estilos en la tabla
    appState.hotNumbersGlobal = sortedFreq.slice(0, 15).map(x => x.num);
    
    // 3. Renderizar Cuadrícula de Calor (Heatmap)
    const maxFreq = Math.max(...frecuencias);
    const minFreq = Math.min(...frecuencias);
    const heatmapGrid = document.getElementById("heatmapGrid");
    heatmapGrid.innerHTML = "";
    
    for (let i = 0; i < 100; i++) {
        const freq = frecuencias[i];
        const cell = document.createElement("div");
        cell.className = "heatmap-cell";
        
        // Calcular color e intensidad HSL basada en frecuencia
        // Frecuencia mínima = opacidad 0.05, frecuencia máxima = opacidad 1.0
        let opacity = 0.05;
        if (maxFreq > minFreq) {
            opacity = 0.05 + ((freq - minFreq) / (maxFreq - minFreq)) * 0.85;
        }
        
        // Color basado en cian (190 deg)
        cell.style.backgroundColor = `hsla(190, 90%, 45%, ${opacity})`;
        
        // Si la celda es muy clara, cambiar color de texto para asegurar contraste
        if (opacity > 0.6) {
            cell.style.color = "#0b0f19";
        } else {
            cell.style.color = "#f8fafc";
        }
        
        // HTML de la celda
        cell.innerHTML = `
            <span class="num">${padZero(i)}</span>
            <span class="freq-badge">${freq}</span>
        `;
        
        // Tooltip del navegador en hover
        cell.title = `Número ${padZero(i)}: ${freq} apariciones`;
        
        heatmapGrid.appendChild(cell);
    }
    
    // 4. Renderizar Gráfico de Pares vs Impares
    renderParImparChart(parCount, imparCount);
    
    // 5. Renderizar Gráfico por Decenas
    renderDecenasChart(decenasCount);
    
    // 6. Renderizar Gráfico de Top 15 Frecuentes
    const top15 = sortedFreq.slice(0, 15);
    renderTopFrecuentesChart(top15.map(x => padZero(x.num)), top15.map(x => x.freq));
    
    // 7. Renderizar Lista de Demoras (Números con mayor retraso sin aparecer)
    const delayListContainer = document.getElementById("delayList");
    delayListContainer.innerHTML = "";
    
    const delayList = delayMap.map((delay, num) => ({
        num,
        delay: delay === null ? hist.length : delay
    })).sort((a, b) => b.delay - a.delay).slice(0, 10);
    
    delayList.forEach(item => {
        const delayItem = document.createElement("div");
        delayItem.className = "delay-item";
        delayItem.innerHTML = `
            <div class="delay-num-badge">${padZero(item.num)}</div>
            <div class="delay-info">
                <div class="delay-count">${item.delay} sorteos</div>
                <div class="delay-label">Demora acumulada</div>
            </div>
        `;
        delayListContainer.appendChild(delayItem);
    });
}

function renderParImparChart(pares, impares) {
    const total = pares + impares;
    const pctPares = ((pares / total) * 100).toFixed(1);
    const pctImpares = ((impares / total) * 100).toFixed(1);
    
    const config = {
        type: 'doughnut',
        data: {
            labels: [`Pares (${pctPares}%)`, `Impares (${pctImpares}%)`],
            datasets: [{
                data: [pares, impares],
                backgroundColor: ['#06b6d4', '#8b5cf6'],
                borderColor: '#1e293b',
                borderWidth: 2,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 12, padding: 15 }
                }
            },
            cutout: '65%'
        }
    };
    
    updateChartInstance('chartParImpar', config);
}

function renderDecenasChart(decenas) {
    const labels = ['00-09', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-99'];
    const config = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Apariciones',
                data: decenas,
                backgroundColor: 'rgba(6, 182, 212, 0.4)',
                borderColor: '#06b6d4',
                borderWidth: 1.5,
                borderRadius: 4,
                hoverBackgroundColor: 'rgba(6, 182, 212, 0.8)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { grid: { color: 'rgba(255, 255, 255, 0.05)' } },
                x: { grid: { display: false } }
            }
        }
    };
    
    updateChartInstance('chartDecenas', config);
}

function renderTopFrecuentesChart(labels, values) {
    const config = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Frecuencia Total',
                data: values,
                backgroundColor: 'rgba(139, 92, 246, 0.4)',
                borderColor: '#8b5cf6',
                borderWidth: 1.5,
                borderRadius: 4,
                hoverBackgroundColor: 'rgba(139, 92, 246, 0.8)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { grid: { color: 'rgba(255, 255, 255, 0.05)' } },
                x: { grid: { display: false } }
            }
        }
    };
    
    updateChartInstance('chartTopFrecuentes', config);
}

function updateChartInstance(canvasId, config) {
    if (appState.charts[canvasId]) {
        appState.charts[canvasId].destroy();
    }
    const ctx = document.getElementById(canvasId).getContext('2d');
    appState.charts[canvasId] = new Chart(ctx, config);
}


// --- PESTAÑA: TOP 20 POR MES ---
function renderTop20MonthSelector() {
    const t20 = appState.data.top20;
    const monthSelect = document.getElementById("monthSelect");
    monthSelect.innerHTML = "";
    
    if (t20.length === 0) {
        const option = document.createElement("option");
        option.textContent = "Sin datos de Top 20";
        monthSelect.appendChild(option);
        return;
    }
    
    // Obtener los meses únicos en el orden en que aparecen
    const mesesUnicos = [...new Set(t20.map(item => item.Mes))];
    
    mesesUnicos.forEach(mes => {
        const option = document.createElement("option");
        option.value = mes;
        option.textContent = mes;
        monthSelect.appendChild(option);
    });
    
    // Seleccionar el último mes de la lista
    if (mesesUnicos.length > 0) {
        appState.selectedMonth = mesesUnicos[mesesUnicos.length - 1];
        monthSelect.value = appState.selectedMonth;
        renderMonthlyTop20(appState.selectedMonth);
    }
    
    // Escuchar cambios
    monthSelect.onchange = (e) => {
        appState.selectedMonth = e.target.value;
        renderMonthlyTop20(appState.selectedMonth);
    };
}

function renderMonthlyTop20(month) {
    const t20 = appState.data.top20;
    const filtered = t20.filter(item => item.Mes === month);
    
    // Actualizar títulos
    document.getElementById("top20-chart-title").textContent = `Frecuencia de Aparición - Top 20 en ${month}`;
    document.getElementById("top20-table-title").textContent = `Datos del Top 20 (${month})`;
    
    const tableBody = document.getElementById("top20TableBody");
    tableBody.innerHTML = "";
    
    if (filtered.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="3" style="text-align:center;">No hay registros para este mes.</td></tr>`;
        return;
    }
    
    // Render Tabla
    filtered.forEach((item, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight: 700; color: var(--color-accent); font-size: 1.1rem;">${padZero(item.Numero)}</td>
            <td>${item.Frecuencia} apariciones</td>
            <td><span class="ball" style="background: rgba(255,255,255,0.05); font-size:0.8rem;">#${idx + 1}</span></td>
        `;
        tableBody.appendChild(tr);
    });
    
    // Render Gráfico
    const labels = filtered.map(x => padZero(x.Numero));
    const values = filtered.map(x => x.Frecuencia);
    
    const config = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Frecuencia Mensual',
                data: values,
                backgroundColor: 'rgba(6, 182, 212, 0.5)',
                borderColor: '#06b6d4',
                borderWidth: 1.5,
                borderRadius: 4,
                hoverBackgroundColor: 'rgba(139, 92, 246, 0.8)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { 
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { stepSize: 1 } 
                },
                x: { grid: { display: false } }
            }
        }
    };
    
    updateChartInstance('chartMonthlyTop20', config);
}


// --- PESTAÑA: HISTORIAL DE SORTEOS ---
function initHistoryTable() {
    // Configurar búsqueda reactiva
    const searchInput = document.getElementById("historySearch");
    searchInput.addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase().trim();
        
        if (query === "") {
            appState.filteredHistorial = [...appState.data.historial];
        } else {
            appState.filteredHistorial = appState.data.historial.filter(sorteo => {
                const sorteoNum = sorteo.Sorteo.toString();
                const fecha = sorteo.Fecha.toLowerCase();
                return sorteoNum.includes(query) || fecha.includes(query);
            });
        }
        
        appState.historyPage = 1;
        renderHistoryTable();
    });
    
    // Paginación
    document.getElementById("btn-page-first").onclick = () => {
        appState.historyPage = 1;
        renderHistoryTable();
    };
    
    document.getElementById("btn-page-prev").onclick = () => {
        if (appState.historyPage > 1) {
            appState.historyPage--;
            renderHistoryTable();
        }
    };
    
    document.getElementById("btn-page-next").onclick = () => {
        const maxPage = Math.ceil(appState.filteredHistorial.length / appState.historyPerPage);
        if (appState.historyPage < maxPage) {
            appState.historyPage++;
            renderHistoryTable();
        }
    };
    
    document.getElementById("btn-page-last").onclick = () => {
        const maxPage = Math.ceil(appState.filteredHistorial.length / appState.historyPerPage);
        appState.historyPage = maxPage;
        renderHistoryTable();
    };
    
    // Ordenamiento por Columnas
    document.getElementById("th-sorteo").onclick = () => toggleHistorySorting("Sorteo");
    document.getElementById("th-fecha").onclick = () => toggleHistorySorting("Fecha");
}

function toggleHistorySorting(column) {
    if (appState.historySortColumn === column) {
        appState.historySortAscending = !appState.historySortAscending;
    } else {
        appState.historySortColumn = column;
        appState.historySortAscending = true;
    }
    
    applyHistorySorting();
    renderHistoryTable();
}

function applyHistorySorting() {
    const col = appState.historySortColumn;
    const asc = appState.historySortAscending;
    
    // Actualizar encabezados de tabla para indicar el orden
    const thSorteo = document.getElementById("th-sorteo");
    const thFecha = document.getElementById("th-fecha");
    
    thSorteo.textContent = `N° Sorteo ${col === 'Sorteo' ? (asc ? '▲' : '▼') : '▲▼'}`;
    thFecha.textContent = `Fecha ${col === 'Fecha' ? (asc ? '▲' : '▼') : '▲▼'}`;
    
    appState.filteredHistorial.sort((a, b) => {
        if (col === "Sorteo") {
            return asc ? a.Sorteo - b.Sorteo : b.Sorteo - a.Sorteo;
        } else if (col === "Fecha") {
            const dateA = parseDateStr(a.Fecha);
            const dateB = parseDateStr(b.Fecha);
            return asc ? dateA - dateB : dateB - dateA;
        }
        return 0;
    });
}

function renderHistoryTable() {
    const tableBody = document.getElementById("historyTableBody");
    tableBody.innerHTML = "";
    
    const count = appState.filteredHistorial.length;
    const totalPages = Math.max(1, Math.ceil(count / appState.historyPerPage));
    
    // Asegurar que la página actual esté en rango
    if (appState.historyPage > totalPages) {
        appState.historyPage = totalPages;
    }
    
    // Controles de Paginación habilitados/deshabilitados
    document.getElementById("btn-page-first").disabled = appState.historyPage === 1;
    document.getElementById("btn-page-prev").disabled = appState.historyPage === 1;
    document.getElementById("btn-page-next").disabled = appState.historyPage === totalPages;
    document.getElementById("btn-page-last").disabled = appState.historyPage === totalPages;
    
    document.getElementById("paginationInfo").textContent = `Pág. ${appState.historyPage} de ${totalPages} (Total: ${count})`;
    
    if (count === 0) {
        tableBody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding: 30px;">No se encontraron sorteos coincidentes.</td></tr>`;
        return;
    }
    
    // Calcular rango de la página actual
    const startIdx = (appState.historyPage - 1) * appState.historyPerPage;
    const endIdx = Math.min(startIdx + appState.historyPerPage, count);
    
    const pageData = appState.filteredHistorial.slice(startIdx, endIdx);
    
    pageData.forEach(sorteo => {
        const tr = document.createElement("tr");
        
        // Formar el html de las bolillas
        let ballsHtml = `<div class="ball-row">`;
        for (let p = 1; p <= 10; p++) {
            const val = sorteo[`Pos ${p}`];
            if (val !== undefined && val !== null && val !== "") {
                const numVal = parseInt(val);
                // Si el número está en el top de los más frecuentes globales, marcarlo como hot-ball
                const isHot = appState.hotNumbersGlobal && appState.hotNumbersGlobal.includes(numVal);
                ballsHtml += `<span class="ball ${isHot ? 'hot-ball' : ''}">${padZero(val)}</span>`;
            }
        }
        ballsHtml += `</div>`;
        
        tr.innerHTML = `
            <td style="font-weight: 700; color: var(--color-accent); font-size:1.05rem;">${sorteo.Sorteo}</td>
            <td style="font-weight: 500;">${sorteo.Fecha}</td>
            <td>${ballsHtml}</td>
        `;
        tableBody.appendChild(tr);
    });
}


// --- PESTAÑA: SIMULADOR DE JUGADA ---
function initSimulator() {
    const simInputGroup = document.getElementById("simInputGroup");
    
    // Añadir Bolilla
    document.getElementById("btn-add-sim-ball").onclick = () => {
        const inputs = simInputGroup.querySelectorAll(".sim-ball-input");
        if (inputs.length >= 8) {
            alert("Puedes simular un máximo de 8 números.");
            return;
        }
        
        const newInput = document.createElement("input");
        newInput.type = "text";
        newInput.maxLength = 2;
        newInput.className = "sim-ball-input";
        newInput.placeholder = "00";
        newInput.setAttribute("aria-label", `Número de bolilla ${inputs.length + 1}`);
        setupSimInputBehavior(newInput);
        simInputGroup.appendChild(newInput);
    };
    
    // Quitar Bolilla
    document.getElementById("btn-remove-sim-ball").onclick = () => {
        const inputs = simInputGroup.querySelectorAll(".sim-ball-input");
        if (inputs.length <= 2) {
            alert("Debes seleccionar al menos 2 números para la jugada.");
            return;
        }
        simInputGroup.removeChild(inputs[inputs.length - 1]);
    };
    
    // Configurar comportamiento inicial de inputs
    simInputGroup.querySelectorAll(".sim-ball-input").forEach(setupSimInputBehavior);
    
    // Botón Simular
    document.getElementById("btn-run-simulation").onclick = runSimulation;
    
    // Botón Limpiar
    document.getElementById("btn-clear-sim").onclick = resetSimulator;
}

function setupSimInputBehavior(input) {
    // Solo permitir números
    input.addEventListener("input", (e) => {
        let val = e.target.value.replace(/\D/g, "");
        e.target.value = val;
        
        // Auto-foco al siguiente input cuando se completan 2 dígitos
        if (val.length === 2) {
            const next = input.nextElementSibling;
            if (next && next.classList.contains("sim-ball-input")) {
                next.focus();
                next.select();
            }
        }
    });
    
    // Seleccionar todo en foco
    input.addEventListener("focus", (e) => {
        e.target.select();
    });
}

function resetSimulator() {
    const simInputGroup = document.getElementById("simInputGroup");
    // Restablecer a 5 entradas por defecto
    simInputGroup.innerHTML = "";
    for (let i = 0; i < 5; i++) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.maxLength = 2;
        inp.className = "sim-ball-input";
        inp.placeholder = "00";
        inp.setAttribute("aria-label", `Número de bolilla ${i + 1}`);
        setupSimInputBehavior(inp);
        simInputGroup.appendChild(inp);
    }
    
    document.getElementById("simMetricsPanel").style.display = "none";
    document.getElementById("simResultsPanel").style.display = "none";
}

function runSimulation() {
    const inputs = document.querySelectorAll("#simInputGroup .sim-ball-input");
    const userNumbers = [];
    let hasError = false;
    
    // 1. Validar entradas
    inputs.forEach((inp, idx) => {
        const raw = inp.value.trim();
        if (raw === "") {
            alert(`Por favor, rellena el campo #${idx + 1}`);
            inp.focus();
            hasError = true;
            return;
        }
        
        const num = parseInt(raw);
        if (isNaN(num) || num < 0 || num > 99) {
            alert(`El número #${idx + 1} (${raw}) debe estar entre 00 y 99`);
            inp.focus();
            hasError = true;
            return;
        }
        
        if (userNumbers.includes(num)) {
            alert(`El número ${padZero(num)} está duplicado.`);
            inp.focus();
            hasError = true;
            return;
        }
        
        userNumbers.push(num);
    });
    
    if (hasError) return;
    
    const hist = appState.data.historial;
    if (hist.length === 0) {
        alert("No hay sorteos cargados en la base de datos.");
        return;
    }
    
    // 2. Procesar coincidencias en el historial
    let hits2 = 0;
    let hits3 = 0;
    let hits4 = 0;
    let hits5plus = 0;
    
    const matchingDraws = [];
    
    hist.forEach(sorteo => {
        // Obtener los números del sorteo
        const drawNumbers = [];
        for (let p = 1; p <= 10; p++) {
            const val = sorteo[`Pos ${p}`];
            if (val !== undefined && val !== null && val !== "") {
                drawNumbers.push(parseInt(val));
            }
        }
        
        // Contar coincidencias
        const matched = userNumbers.filter(n => drawNumbers.includes(n));
        const hitCount = matched.length;
        
        if (hitCount >= 2) {
            if (hitCount === 2) hits2++;
            else if (hitCount === 3) hits3++;
            else if (hitCount === 4) hits4++;
            else hits5plus++;
            
            matchingDraws.push({
                sorteo: sorteo.Sorteo,
                fecha: sorteo.Fecha,
                drawNumbers: drawNumbers,
                matched: matched,
                hitCount: hitCount
            });
        }
    });
    
    // 3. Actualizar paneles y métricas en pantalla
    document.getElementById("sim-hits-2").textContent = hits2;
    document.getElementById("sim-hits-3").textContent = hits3;
    document.getElementById("sim-hits-4").textContent = hits4;
    document.getElementById("sim-hits-5").textContent = hits5plus;
    
    document.getElementById("simMetricsPanel").style.display = "grid";
    
    // 4. Renderizar tabla de coincidencias
    const tableBody = document.getElementById("simResultsTableBody");
    tableBody.innerHTML = "";
    
    const resultsPanel = document.getElementById("simResultsPanel");
    resultsPanel.style.display = "block";
    
    if (matchingDraws.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px;">Tu jugada nunca obtuvo 2 o más aciertos.</td></tr>`;
        return;
    }
    
    // Ordenar resultados por cantidad de aciertos descendente, y luego por sorteo descendente
    matchingDraws.sort((a, b) => b.hitCount - a.hitCount || b.sorteo - a.sorteo);
    
    // Mostrar máximo de 100 coincidencias para evitar ralentizar la página
    const showLimit = Math.min(matchingDraws.length, 100);
    
    for (let i = 0; i < showLimit; i++) {
        const res = matchingDraws[i];
        const tr = document.createElement("tr");
        
        // Bolillas de este sorteo, resaltando las acertadas
        let ballsHtml = `<div class="ball-row">`;
        res.drawNumbers.forEach(n => {
            const isHit = res.matched.includes(n);
            ballsHtml += `<span class="ball ${isHit ? 'hot-ball' : ''}" style="${isHit ? 'background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-color: #34d399; color: white;' : ''}">${padZero(n)}</span>`;
        });
        ballsHtml += `</div>`;
        
        // Tus números que acertaste
        const hitBallsHtml = res.matched.map(n => `<span class="ball" style="background: rgba(16, 185, 129, 0.2); border-color: rgba(16, 185, 129, 0.4); color: #34d399; font-weight: 800;">${padZero(n)}</span>`).join(" ");
        
        // Badge de aciertos
        let hitsBadgeColor = "var(--text-secondary)";
        if (res.hitCount >= 5) hitsBadgeColor = "var(--color-warning)";
        else if (res.hitCount === 4) hitsBadgeColor = "var(--color-purple)";
        else if (res.hitCount === 3) hitsBadgeColor = "var(--color-accent)";
        else if (res.hitCount === 2) hitsBadgeColor = "var(--color-success)";
        
        tr.innerHTML = `
            <td style="font-weight: 700;">${res.sorteo}</td>
            <td>${res.fecha}</td>
            <td>${ballsHtml}</td>
            <td><div style="display:flex; gap: 4px;">${hitBallsHtml}</div></td>
            <td style="font-weight: 800; color: ${hitsBadgeColor}; font-size: 1.1rem;">${res.hitCount} aciertos</td>
        `;
        tableBody.appendChild(tr);
    }
    
    if (matchingDraws.length > 100) {
        const trLimit = document.createElement("tr");
        trLimit.innerHTML = `<td colspan="5" style="text-align:center; color: var(--text-muted); font-size: 0.8rem; padding: 15px;">... Mostrando las mejores 100 coincidencias de un total de ${matchingDraws.length} sorteos ...</td>`;
        tableBody.appendChild(trLimit);
    }
}


// --- PESTAÑA: ACTUALIZAR SORTEOS (SCRAPER) ---
function initScraper() {
    const startInput = document.getElementById("scrapeStart");
    const endInput = document.getElementById("scrapeEnd");
    
    // Auto-completar valores sugeridos basados en el historial cargado
    // El sorteo inicial sugerido suele ser el último + 1, o el último en la base de datos
    setTimeout(() => {
        const hist = appState.data.historial;
        if (hist.length > 0) {
            const maxSorteo = hist[0].Sorteo;
            startInput.value = maxSorteo + 1;
            endInput.value = maxSorteo;
        } else {
            startInput.value = 936;
            endInput.value = 930;
        }
    }, 1000);
    
    // Formulario de inicio
    document.getElementById("btn-start-scrape").onclick = startScraping;
    
    // Botón de cancelación
    document.getElementById("btn-cancel-scrape").onclick = cancelScraping;
}

async function startScraping() {
    const startVal = parseInt(document.getElementById("scrapeStart").value);
    const endVal = parseInt(document.getElementById("scrapeEnd").value);
    
    if (isNaN(startVal) || startVal <= 0 || isNaN(endVal) || endVal <= 0) {
        alert("Por favor, introduce números de sorteo válidos.");
        return;
    }
    
    // Iniciar petición en el servidor
    try {
        const response = await fetch("/api/scrape", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                file: appState.selectedFile,
                inicio: startVal,
                fin: endVal
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || "Error al iniciar el raspador.");
        }
        
        // Éxito al iniciar
        appState.isScraping = true;
        document.getElementById("btn-start-scrape").disabled = true;
        document.getElementById("btn-cancel-scrape").disabled = false;
        document.getElementById("scrapeProgressSection").classList.add("active");
        
        // Limpiar consola
        const consoleBox = document.getElementById("scrapeConsole");
        consoleBox.innerHTML = `<div class="console-line">Iniciando conexión con el servidor...</div>`;
        
        // Comenzar polling de estado
        if (appState.scrapeInterval) clearInterval(appState.scrapeInterval);
        appState.scrapeInterval = setInterval(pollScrapeStatus, 600);
        
    } catch (error) {
        alert("Error: " + error.message);
    }
}

async function cancelScraping() {
    try {
        document.getElementById("btn-cancel-scrape").disabled = true;
        const response = await fetch("/api/scrape/cancel", { method: "POST" });
        if (response.ok) {
            appendConsoleLine("Solicitud de cancelación enviada al hilo de fondo...", "warning");
        }
    } catch (error) {
        console.error(error);
    }
}

async function pollScrapeStatus() {
    try {
        const response = await fetch("/api/scrape/status");
        if (!response.ok) return;
        const status = await response.json();
        
        // 1. Renderizar Consola / Bitácora
        const consoleBox = document.getElementById("scrapeConsole");
        // Rellenar líneas
        consoleBox.innerHTML = "";
        status.logs.forEach(line => {
            const lineDiv = document.createElement("div");
            lineDiv.className = "console-line";
            
            // Estilos de color para la bitácora
            if (line.includes("✔")) lineDiv.classList.add("success");
            else if (line.includes("⚠")) lineDiv.classList.add("warning");
            else if (line.includes("ERROR") || line.includes("Falló")) lineDiv.classList.add("danger");
            
            lineDiv.textContent = line;
            consoleBox.appendChild(lineDiv);
        });
        
        // Auto-scroll al fondo de la consola
        consoleBox.scrollTop = consoleBox.scrollHeight;
        
        // 2. Renderizar Barra de Progreso
        if (status.total > 0) {
            const pct = Math.floor((status.progress / status.total) * 100);
            document.getElementById("scrapeProgressBar").style.width = `${pct}%`;
            document.getElementById("scrapeProgressPercent").textContent = `${pct}%`;
            document.getElementById("scrapeProgressLabel").textContent = `Procesando: Sorteo ${status.current_sorteo || '-'} (${status.progress} de ${status.total})`;
        }
        
        // 3. Comprobar si finalizó
        if (!status.running) {
            clearInterval(appState.scrapeInterval);
            appState.isScraping = false;
            
            document.getElementById("btn-start-scrape").disabled = false;
            document.getElementById("btn-cancel-scrape").disabled = true;
            
            if (status.error) {
                appendConsoleLine(`>>> PROCESO FINALIZADO CON ERRORES: ${status.error}`, "danger");
                alert(`El proceso finalizó con un error: ${status.error}`);
            } else {
                appendConsoleLine(">>> PROCESO COMPLETADO EXITOSAMENTE.", "success");
                
                // Pequeño retardo y recarga de datos automáticamente
                setTimeout(async () => {
                    await loadFileData(appState.selectedFile);
                    alert("¡Extracción de sorteos completada! Los datos se han recargado en el Dashboard.");
                }, 1000);
            }
        }
    } catch (error) {
        console.error("Error al sondear estado del scraping:", error);
    }
}

function appendConsoleLine(text, type = "") {
    const consoleBox = document.getElementById("scrapeConsole");
    const lineDiv = document.createElement("div");
    lineDiv.className = "console-line";
    if (type) lineDiv.classList.add(type);
    
    const timestamp = new Date().toLocaleTimeString();
    lineDiv.textContent = `[${timestamp}] ${text}`;
    consoleBox.appendChild(lineDiv);
    consoleBox.scrollTop = consoleBox.scrollHeight;
}


// --- CONFIGURACIÓN DE EVENTOS INICIALES ---
window.addEventListener("DOMContentLoaded", () => {
    // 1. Pestañas
    initTabs();
    
    // 2. Simulador
    initSimulator();
    
    // 3. Historial (Paginación y búsquedas)
    initHistoryTable();
    
    // 4. Scraper
    initScraper();
    
    // 5. Cargar lista de archivos Excel
    loadFilesList();
    
    // Evento al cambiar de Archivo Excel
    document.getElementById("excelFileSelect").addEventListener("change", (e) => {
        appState.selectedFile = e.target.value;
        document.getElementById("targetScrapeFile").value = appState.selectedFile;
        
        // Cargar los nuevos datos
        loadFileData(appState.selectedFile);
        
        // Si hay scraping activo, cancelar
        if (appState.isScraping) {
            clearInterval(appState.scrapeInterval);
            appState.isScraping = false;
            document.getElementById("btn-start-scrape").disabled = false;
            document.getElementById("btn-cancel-scrape").disabled = true;
            document.getElementById("scrapeProgressSection").classList.remove("active");
        }
    });
});
