import http.server
import socketserver
import json
import os
import re
import time
import datetime
import threading
from urllib.parse import urlparse, parse_qs
import pandas as pd
import requests
from bs4 import BeautifulSoup

# --- Configuración ---
PORT = 8000
DIRECTORY = os.getcwd()

# --- Estado del Raspador (Scraper) ---
scrape_state = {
    "running": False,
    "progress": 0,
    "total": 0,
    "current_sorteo": None,
    "logs": [],
    "error": None
}
scrape_lock = threading.Lock()

def extraer_sorteo_poceada(id_sorteo):
    url = f"https://loteria.chaco.gov.ar/detalle_poceada/{id_sorteo}"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code != 200:
            return None

        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Extraer fecha
        header_section = soup.find('div', class_='title')
        fecha_texto = None
        if header_section:
            fecha_h5 = header_section.find('h5')
            if fecha_h5:
                fecha_texto = fecha_h5.get_text(strip=True)
                # Limpiar fecha usando regex si contiene texto extra
                match = re.search(r'(\d{2}[/-]\d{2}[/-]\d{4})', fecha_texto)
                if match:
                    fecha_texto = match.group(1)

        # Extraer números
        lista_resultados = soup.find('ul', class_='results-list')
        if not lista_resultados:
            return None

        numeros = []
        items = lista_resultados.find_all('li', class_='results-list__item')
        for item in items:
            if 'headers' in item.get('class', []):
                continue
            parrafos = item.find_all('p', class_='results-number')
            if len(parrafos) >= 2:
                num_raw = parrafos[1].get_text(strip=True)
                if num_raw.isdigit():
                    numeros.append(int(num_raw))
        
        return {"fecha": fecha_texto, "numeros": numeros}
    except Exception:
        return None

def scrape_worker(file_name, inicio, fin):
    global scrape_state
    
    def log(msg):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        formatted_msg = f"[{timestamp}] {msg}"
        with scrape_lock:
            scrape_state["logs"].append(formatted_msg)
        print(formatted_msg)
        
    try:
        log(f"Iniciando raspado de sorteos del {inicio} al {fin}...")
        
        # Los sorteos se procesan del inicial al final (usualmente descendente)
        step = -1 if inicio >= fin else 1
        sorteos = list(range(inicio, fin + step, step))
        total = len(sorteos)
        
        with scrape_lock:
            scrape_state["total"] = total
            scrape_state["progress"] = 0
            
        datos_lista = []
        
        for idx, i in enumerate(sorteos):
            # Comprobar si se canceló el proceso
            with scrape_lock:
                if not scrape_state["running"]:
                    log("Proceso cancelado por el usuario.")
                    break
                scrape_state["current_sorteo"] = i
                
            log(f"Procesando sorteo {i} ({idx + 1}/{total})...")
            res = extraer_sorteo_poceada(i)
            
            if res and res["numeros"]:
                # Formatear la fecha a dd-mm-yyyy si viene con "/"
                fecha_fmt = res["fecha"]
                if fecha_fmt and "/" in fecha_fmt:
                    fecha_fmt = fecha_fmt.replace("/", "-")
                
                fila = {"Fecha": fecha_fmt, "Sorteo": i}
                for num_idx, n in enumerate(res["numeros"], start=1):
                    fila[f"Pos {num_idx}"] = n
                datos_lista.append(fila)
                log(f"✔ Sorteo {i} procesado correctamente.")
            else:
                log(f"⚠ Sorteo {i} no disponible o no se encontraron datos.")
                
            with scrape_lock:
                scrape_state["progress"] = idx + 1
                
            time.sleep(0.3)
            
        with scrape_lock:
            if not scrape_state["running"]:
                return
                
        if datos_lista:
            log(f"Extracción finalizada. Se procesaron {len(datos_lista)} sorteos válidos.")
            log("Guardando datos en el archivo Excel...")
            
            file_path = os.path.join(DIRECTORY, file_name)
            
            # Cargar datos existentes si el archivo existe
            df_existing = pd.DataFrame()
            if os.path.exists(file_path):
                try:
                    df_existing = pd.read_excel(file_path, sheet_name='Historial')
                    log(f"Archivo existente '{file_name}' cargado con {len(df_existing)} sorteos.")
                except Exception as e:
                    log(f"No se pudo leer el archivo existente: {str(e)}. Se creará uno nuevo.")
            
            df_new = pd.DataFrame(datos_lista)
            
            # Combinar datos existentes con nuevos
            if not df_existing.empty:
                df_combined = pd.concat([df_new, df_existing], ignore_index=True)
                # Eliminar duplicados por número de Sorteo, priorizando los datos nuevos
                df_combined = df_combined.drop_duplicates(subset=['Sorteo'], keep='first')
            else:
                df_combined = df_new
                
            # Ordenar sorteos descendentemente
            df_combined = df_combined.sort_values(by='Sorteo', ascending=False)
            
            # Analizar frecuencias mensuales para la pestaña Top20
            # Convertimos fecha temporalmente para el agrupamiento
            df_combined['Fecha_dt'] = pd.to_datetime(df_combined['Fecha'], dayfirst=True, errors='coerce')
            
            df_long = df_combined.melt(id_vars=['Fecha_dt'], 
                                        value_vars=[c for c in df_combined.columns if 'Pos ' in c],
                                        value_name='Numero')
            
            # Agrupar por mes y número
            df_long['Mes'] = df_long['Fecha_dt'].dt.to_period('M').dt.to_timestamp()
            conteo_mensual = df_long.groupby(['Mes', 'Numero']).size().reset_index(name='Frecuencia')
            
            # Ordenar por mes (ascendente) y frecuencia (descendente)
            df_top20 = conteo_mensual.sort_values(['Mes', 'Frecuencia'], ascending=[True, False])
            # Tomar los top 20 de cada mes
            df_top20 = df_top20.groupby('Mes').head(20).copy()
            
            # Formatear la fecha en el historial a string dd-mm-yyyy antes de guardar
            df_combined['Fecha'] = df_combined['Fecha_dt'].dt.strftime('%d-%m-%Y')
            df_combined = df_combined.drop(columns=['Fecha_dt'])
            
            # Formatear la fecha del mes a texto en español "Mes Año" para el Excel
            meses_es = {
                1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril', 5: 'Mayo', 6: 'Junio',
                7: 'Julio', 8: 'Agosto', 9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre'
            }
            
            df_top20_excel = df_top20.copy()
            df_top20_excel['Mes'] = df_top20_excel['Mes'].dt.month.map(meses_es) + " " + df_top20_excel['Mes'].dt.year.astype(str)
            
            # Guardar el libro de Excel con formato tabla en dos hojas
            with pd.ExcelWriter(file_path, engine='xlsxwriter') as writer:
                # Hoja 1: Historial
                df_combined.to_excel(writer, sheet_name='Historial', index=False)
                worksheet1 = writer.sheets['Historial']
                (max_row, max_col) = df_combined.shape
                column_settings = [{'header': column} for column in df_combined.columns]
                worksheet1.add_table(0, 0, max_row, max_col - 1, {
                    'columns': column_settings,
                    'style': 'TableStyleMedium9'
                })
                
                # Hoja 2: Top20
                df_top20_excel.to_excel(writer, sheet_name='Top20', index=False)
                worksheet2 = writer.sheets['Top20']
                worksheet2.set_column('A:A', 18)
                (max_row2, max_col2) = df_top20_excel.shape
                column_settings2 = [{'header': column} for column in df_top20_excel.columns]
                worksheet2.add_table(0, 0, max_row2, max_col2 - 1, {
                    'columns': column_settings2,
                    'style': 'TableStyleMedium10'
                })
                
            log(f"✔ ¡Proceso finalizado con éxito! Datos guardados en '{file_name}'.")
        else:
            log("⚠ No se extrajo ningún sorteo nuevo válido en este rango.")
            
    except Exception as e:
        import traceback
        err_msg = f"ERROR en el proceso de scraping: {str(e)}\n{traceback.format_exc()}"
        log(err_msg)
        with scrape_lock:
            scrape_state["error"] = str(e)
    finally:
        with scrape_lock:
            scrape_state["running"] = False


# --- Manejador de Solicitudes HTTP ---
class DashboardAPIHandler(http.server.SimpleHTTPRequestHandler):
    
    def log_message(self, format, *args):
        # Evitar inundar la terminal con registros de polling estáticos
        if "GET /api/scrape/status" in args[0] or "static" in self.path:
            return
        super().log_message(format, *args)
        
    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        
        # API: Obtener lista de archivos Excel de poceada
        if path == "/api/files":
            files = [f for f in os.listdir(DIRECTORY) if f.startswith("poceada") and f.endswith(".xlsx")]
            # Asegurar que poceada.xlsx esté primero si existe
            if "poceada.xlsx" in files:
                files.remove("poceada.xlsx")
                files.insert(0, "poceada.xlsx")
                
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(files).encode("utf-8"))
            return
            
        # API: Obtener datos del archivo seleccionado
        elif path == "/api/data":
            query_components = parse_qs(parsed_url.query)
            file_name = query_components.get("file", ["poceada.xlsx"])[0]
            
            # Sanitizar nombre de archivo
            file_name = os.path.basename(file_name)
            file_path = os.path.join(DIRECTORY, file_name)
            
            if not os.path.exists(file_path):
                self.send_error(404, f"Archivo {file_name} no encontrado")
                return
                
            try:
                # Leer ambas hojas de Excel
                df_historial = pd.read_excel(file_path, sheet_name='Historial')
                df_top20 = pd.read_excel(file_path, sheet_name='Top20')
                
                # Reemplazar valores nulos (NaN, NaT, etc.)
                df_historial = df_historial.fillna("")
                df_top20 = df_top20.fillna("")
                
                # Convertir fechas a string seguro si son objetos datetime en pandas
                for col in df_historial.columns:
                    if pd.api.types.is_datetime64_any_dtype(df_historial[col]):
                        df_historial[col] = df_historial[col].dt.strftime('%d-%m-%Y')
                
                # Convertir a listas de diccionarios
                historial_data = df_historial.to_dict(orient="records")
                top20_data = df_top20.to_dict(orient="records")
                
                response_data = {
                    "historial": historial_data,
                    "top20": top20_data
                }
                
                self.send_response(200)
                self.send_header("Content-type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(response_data).encode("utf-8"))
                
            except Exception as e:
                self.send_error(500, f"Error al procesar el archivo Excel: {str(e)}")
            return
            
        # API: Obtener estado del scraping
        elif path == "/api/scrape/status":
            with scrape_lock:
                # Hacemos una copia para serializar
                status_copy = dict(scrape_state)
                # Limitar las últimas 100 líneas de log para no saturar
                status_copy["logs"] = status_copy["logs"][-100:]
                
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(status_copy).encode("utf-8"))
            return
            
        # De lo contrario, servir los archivos estáticos estándar
        super().do_GET()

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        
        # API: Iniciar el proceso de scraping
        if path == "/api/scrape":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            params = json.loads(post_data.decode('utf-8'))
            
            file_name = os.path.basename(params.get("file", "poceada.xlsx"))
            inicio = int(params.get("inicio"))
            fin = int(params.get("fin"))
            
            # Verificar si ya está en ejecución
            with scrape_lock:
                if scrape_state["running"]:
                    self.send_response(400)
                    self.send_header("Content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Ya hay un proceso en ejecución"}).encode("utf-8"))
                    return
                
                # Inicializar el estado de scraping
                scrape_state["running"] = True
                scrape_state["progress"] = 0
                scrape_state["total"] = 0
                scrape_state["current_sorteo"] = None
                scrape_state["logs"] = []
                scrape_state["error"] = None
                
            # Lanzar el hilo del trabajador de raspado
            t = threading.Thread(target=scrape_worker, args=(file_name, inicio, fin))
            t.daemon = True
            t.start()
            
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "started"}).encode("utf-8"))
            return
            
        # API: Cancelar el proceso de scraping
        elif path == "/api/scrape/cancel":
            with scrape_lock:
                if scrape_state["running"]:
                    scrape_state["running"] = False
                    status = "cancelling"
                else:
                    status = "not_running"
                    
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": status}).encode("utf-8"))
            return

        self.send_error(404, "Ruta de POST no encontrada")


# --- Punto de Entrada ---
if __name__ == "__main__":
    # Asegurarnos de que el servidor use la codificación UTF-8
    handler = DashboardAPIHandler
    
    # Permitir la reutilización rápida del puerto
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"===========================================================")
        print(f" Servidor iniciado correctamente en: http://localhost:{PORT}")
        print(f" Presiona Ctrl+C en la terminal para apagar el servidor.")
        print(f"===========================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nApagando el servidor...")
