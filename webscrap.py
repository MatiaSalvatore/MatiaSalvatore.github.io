import requests
from bs4 import BeautifulSoup
import time
import pandas as pd
import sys
import tkinter as tk
from tkinter import filedialog

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

# --- Inputs ---
inicio = int(input("Sorteo inicial (ej: 934): "))
fin = int(input("Sorteo final (ej: 900): "))

# Configurar ventana de diálogo para elegir la ubicación de guardado
root = tk.Tk()
root.withdraw() # Oculta la ventana principal vacía de tkinter
print("\nPor favor, elige dónde guardar el archivo en la ventana emergente...")
nombre_archivo = filedialog.asksaveasfilename(
    title="Guardar resultados como",
    defaultextension=".xlsx",
    filetypes=[("Archivos de Excel", "*.xlsx"), ("Todos los archivos", "*.*")]
)

if not nombre_archivo:
    print("Operación cancelada por el usuario. Saliendo del programa.")
    sys.exit()

datos_lista = []
print("\nIniciando extracción...")

for i in range(inicio, fin - 1, -1):
    res = extraer_sorteo_poceada(i)
    if res and res["numeros"]:
        fila = {"Fecha": res["fecha"], "Sorteo": i}
        for idx, n in enumerate(res["numeros"], start=1):
            fila[f"Pos {idx}"] = n
        datos_lista.append(fila)
        print(f"✔ Procesado: {i}")
    time.sleep(0.3)

if datos_lista:
    # --- Procesamiento de Datos ---
    df_historico = pd.DataFrame(datos_lista)
    df_historico['Fecha'] = pd.to_datetime(df_historico['Fecha'], dayfirst=True, errors='coerce')
    
    # Análisis para el Top 20
    df_long = df_historico.melt(id_vars=['Fecha'], 
                                value_vars=[c for c in df_historico.columns if 'Pos ' in c],
                                value_name='Numero')
    
    # Convertimos Mes a fecha (primer día del mes)
    df_long['Mes'] = df_long['Fecha'].dt.to_period('M').dt.to_timestamp()
    
    conteo_mensual = df_long.groupby(['Mes', 'Numero']).size().reset_index(name='Frecuencia')
    df_top20 = conteo_mensual.sort_values(['Mes', 'Frecuencia'], ascending=[True, False])
    df_top20 = df_top20.groupby('Mes').head(20).copy()

    # Formatear la fecha en el historial a dd-mm-yyyy antes de exportar
    df_historico['Fecha'] = df_historico['Fecha'].dt.strftime('%d-%m-%Y')

    # --- Exportación con Formato Tabla ---
    with pd.ExcelWriter(nombre_archivo, engine='xlsxwriter') as writer:
        # Hoja 1: Historial
        df_historico.to_excel(writer, sheet_name='Historial', index=False)
        workbook = writer.book
        worksheet1 = writer.sheets['Historial']
        
        # Crear tabla automática en Hoja 1
        (max_row, max_col) = df_historico.shape
        column_settings = [{'header': column} for column in df_historico.columns]
        worksheet1.add_table(0, 0, max_row, max_col - 1, {
            'columns': column_settings,
            'style': 'TableStyleMedium9'
        })

        # Hoja 2: Top 20
        # Formatear la columna Mes a "Mes Año" antes de exportar
        meses_es = {
            1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril', 5: 'Mayo', 6: 'Junio',
            7: 'Julio', 8: 'Agosto', 9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre'
        }
        df_top20['Mes'] = df_top20['Mes'].dt.month.map(meses_es) + " " + df_top20['Mes'].dt.year.astype(str)
        
        df_top20.to_excel(writer, sheet_name='Top20', index=False)
        worksheet2 = writer.sheets['Top20']
        
        # Ajustar ancho de columna para el nuevo formato de texto
        worksheet2.set_column('A:A', 18)

        # Crear tabla automática en Hoja 2
        (max_row2, max_col2) = df_top20.shape
        column_settings2 = [{'header': column} for column in df_top20.columns]
        worksheet2.add_table(0, 0, max_row2, max_col2 - 1, {
            'columns': column_settings2,
            'style': 'TableStyleMedium10'
        })

    print(f"\n¡Listo! '{nombre_archivo}' creado con tablas y formatos de fecha.")
else:
    print("No se encontraron datos.")