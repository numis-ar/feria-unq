# Cartel QR plegable A4

Una hoja A4 con 2 carteles tipo "carpa" que se doblan en triángulo para apoyar sobre una mesa.

## Qué hay en esta carpeta

```
cartel/
├── imprimir-qr-a4.html
├── generar-cartel.py          ← Genera el PDF leyendo imprimir-qr-a4.html.
├── emojis/                    ← Los ~3.700 emojis de Twemoji (un SVG cada uno) + indice.js.
├── LEEME.md                   ← Este instructivo.
└── regenerar/                 ← Herramientas para volver a armar imprimir-qr-a4.html
    ├── regenerar-pagina.py    ← Configuración (textos, colores, medidas) + armado.
    ├── preparar-emojis.py     ← Arma la carpeta emojis/ .
    ├── datos/                 ← Shortcodes (emojibase-data) y licencias de los emojis.
    ├── plantilla.html         ← Esqueleto de la página: estilos, panel y JavaScript.
    ├── fuentes/               ← Montserrat 600/700/800/900 (licencia OFL en OFL.txt).
    ├── logos/                 ← numis-logo-sobre-verde.svg y taler-logo-2021.svg.
    └── lib/qrcode.js          ← Generador de QR de la página (MIT, Kazuhiko Arase).
```

`imprimir-qr-a4.html`, `generar-cartel.py` y la carpeta `emojis/` tienen que estar
en la misma carpeta (o usá `--html RUTA` y `--emojis CARPETA` con el script). Sin `emojis/`
todo funciona igual, pero no se pueden usar emojis.

## Requisitos (Debian 13)

```bash
sudo apt install weasyprint python3-qrcode     # para generar-cartel.py
sudo apt install python3-fonttools             # para regenerar/regenerar-pagina.py
```

## Uso diario

**Desde el navegador:** abrí `imprimir-qr-a4.html`, poné el link del QR y el texto que va
debajo, y tocá *Imprimir* (A4, escala 100%, márgenes "ninguno", gráficos de fondo
activados).

También se puede abrir con los valores ya cargados:
`imprimir-qr-a4.html#qr=TEXTO_DEL_QR&texto=DESDE%20TU%20CELULAR`

**Desde la terminal:**

```bash
python3 generar-cartel.py "taler://pay/..."                                   # → cartel-qr.pdf
python3 generar-cartel.py "taler://pay/..." -t "Pagá con tu billetera" -o puesto-12.pdf
```

- El texto del QR es obligatorio.
- `--buscar-emoji TEXTO` lista emojis y sus shortcodes (ver **Emojis**).
- `-t` es el texto debajo del QR: hasta **22 caracteres** (el máximo lo calcula la
  herramienta; ver más abajo). Si tiene más, o algún carácter no permitido, el script
  corta con un error.

Los dos caminos dan el mismo PDF.

## Emojis

El texto debajo del QR acepta emojis a color tipo Twemoji. Hay tres formas de escribirlos,
iguales en la página y en el script:

| Forma        | Ejemplo                                   |
|--------------|-------------------------------------------|
| El emoji     | `Venta de zapas 😀`                        |
| Shortcode    | `Venta de zapas :grinning:` o `:cara_sonriendo:` |
| Código       | `Venta de zapas \U0001F600` (o `\u2764` para 4 dígitos) |

```bash
./generar-cartel.py -t "Venta de zapas \U0001F600" -o puesto-zapas.pdf "taler://pay-template/..."
./generar-cartel.py -t "Zapas :athletic_shoe: :fire:" -o puesto-zapas.pdf "taler://..."
./generar-cartel.py --buscar-emoji zapa       # 👟  :zapatilla_deportiva:  …
```

- **Cada emoji cuenta como 1 carácter** del máximo de 22, incluidos los compuestos:
  banderas (🇦🇷), tonos de piel (👍🏽) y secuencias como 🏳️‍🌈.
- **Shortcodes:** los de GitHub/Slack en inglés (`:grinning:`, `:athletic_shoe:`, `:+1:`)
  y los de Unicode en castellano (`:cara_sonriendo:`, `:zapatilla_deportiva:`,
  `:argentina:`). No distingue mayúsculas. Si uno no existe, el script avisa y sugiere
  parecidos; la página lo marca en rojo.
- **En la página** hay un buscador: escribís una parte del nombre (en inglés o
  castellano) y tocás el emoji para agregarlo.
- Un emoji mide lo mismo que una letra de cuerpo (3,4 mm) y queda centrado con
  las mayúsculas (`EMOJI_LADO` y `EMOJI_ARRIBA` en `regenerar-pagina.py`).

### Actualizar los emojis

`emojis/` ya viene armada. Para pasar a otra versión de Twemoji:

```bash
cd regenerar
python3 preparar-emojis.py --twemoji /ruta/a/los/svg/de/twemoji
```

Toma los SVG originales (paquete `@twemoji/svg`), los prepara, rearma `indice.js`
con los shortcodes de `datos/` y copia las licencias. No hace falta regenerar la
página.

### Licencias de los emojis

- Gráficos: **Twemoji**, © Twitter, Inc y colaboradores, licencia **CC-BY 4.0**
  (https://creativecommons.org/licenses/by/4.0/). La licencia pide reconocer la
  autoría: si publicás o distribuís carteles con emojis, mencioná "Emojis: Twemoji
  (CC-BY 4.0)". Detalle en `emojis/LICENCIA-twemoji.txt`.
- Shortcodes: **emojibase-data**, licencia MIT (`emojis/LICENCIA-emojibase.txt`).

## Qué se puede cambiar y dónde

| Quiero cambiar…                                             | Dónde                                   | ¿Hay que regenerar? |
|-------------------------------------------------------------|-----------------------------------------|---------------------|
| El QR o el texto debajo del QR (para un cartel)             | La página o el parámetro del script     | No                  |
| Título, "Con la app de", texto de las solapas               | `regenerar-pagina.py` (CONFIGURACIÓN)   | **Sí**              |
| Textos por defecto (QR y texto debajo)                      | `regenerar-pagina.py` (CONFIGURACIÓN)   | **Sí**              |
| Colores                                                     | `regenerar-pagina.py` (CONFIGURACIÓN)   | **Sí**              |
| Logos                                                       | Reemplazar los SVG en `regenerar/logos/` | **Sí**             |
| Posiciones y tamaños                                        | `regenerar-pagina.py` (MEDIDAS)         | **Sí**              |
| Caracteres permitidos en el texto debajo del QR             | `regenerar-pagina.py` (`PERMITIDOS`)    | **Sí**              |
| Panel de la página, estilos de pantalla, JavaScript          | `regenerar/plantilla.html`              | **Sí**              |
| Tamaño o posición de los emojis                             | `regenerar-pagina.py` (`EMOJI_*`)       | **Sí**              |
| Versión de Twemoji o fuentes de shortcodes                  | `regenerar/preparar-emojis.py`          | No (solo emojis/)   |

> **No edites `imprimir-qr-a4.html` a mano.** Se sobrescribe cada vez que regenerás.
> Todo cambio va en `regenerar/regenerar-pagina.py` o `regenerar/plantilla.html`.

## Cómo regenerar la página

1. Abrí `regenerar/regenerar-pagina.py` y modificá la sección **CONFIGURACIÓN**
   (y, si hace falta, **MEDIDAS**). Por ejemplo:

   ```python
   TITULO = ["PAGÁ ACÁ", "SIN EFECTIVO"]
   PIE = "Pagá desde la app de"
   ```

2. Ejecutá:

   ```bash
   cd regenerar
   python3 regenerar-pagina.py
   ```

   Sobrescribe `../imprimir-qr-a4.html` e informa el máximo de caracteres del texto
   debajo del QR.

3. Listo. La página y `generar-cartel.py` ya usan lo nuevo: el script lee la página
   cada vez que corre, así que no hay nada que copiar.

### Avisos que puede mostrar

- `AVISO: TITULO[0] (...) mide 156.6 mm y se sale del área segura (4–101 mm)`:
  ese texto no entra en el ancho de la cara (105 mm). Acortalo, partilo en más
  renglones o bajá `TITULO_TAM`. Si agregás renglones al título, agregá también su
  línea de base en `TITULO_BASES`.
- `Error: la fuente no tiene el carácter ...`: usaste un carácter que Montserrat
  (subconjunto latino) no trae.

## Detalles técnicos

**Por qué los textos son trazos.** Toda la hoja es un único SVG en milímetros y los
textos se guardan como dibujos de letras, no como letras. Así el navegador y
WeasyPrint dibujan exactamente las mismas formas, sin depender de qué tipografía
haya instalada ni de cómo cada programa ubica el texto. Por eso no se pueden
editar a mano dentro del HTML y existe `regenerar-pagina.py`.

**El texto editable debajo del QR.** La página trae una tabla con el dibujo, el
ancho y el kerning de cada carácter permitido (`const SUB = {...}` en el HTML).
La página (en JavaScript) y el script (en Python) arman el texto con esa misma
tabla y con la misma regla, así que salen idénticos.

**Cómo se calcula el máximo de caracteres.** Es el mayor número de caracteres para
el que *cualquier* combinación de caracteres permitidos y emojis entra en
`SUB_ANCHO_MAX` (93 mm), contando el ancho real, el kerning y el espaciado entre
letras (un emoji mide 1 em, menos que la W). Con
Montserrat SemiBold a 3,4 mm da 22; el peor caso es "WWWW…" (22 W = 92,9 mm).
Si cambiás `PERMITIDOS`, `SUB_ESCALA`, `SUB_ESPACIADO` o `SUB_ANCHO_MAX`, el máximo
se recalcula solo al regenerar.

**El QR.** La página usa `lib/qrcode.js` (nivel de corrección M, modo byte UTF-8).
El script usa `python3-qrcode`, con el mismo criterio para elegir la máscara que la
librería de la página, así que el QR sale idéntico módulo a módulo.

**Lo que está escrito dos veces.** La *lógica* que dibuja el QR y arma el texto
debajo del QR (escapes, shortcodes, separación en letras y emojis, armado) existe en
JavaScript (en `plantilla.html`) y en Python (en `generar-cartel.py`). Los *datos* (hoja, colores, tabla de letras, máximo) están
una sola vez, en `imprimir-qr-a4.html`. Si cambiás esa lógica en un lado, cambiala
también en el otro.

**Tamaño de hoja.** El script usa 594,96 × 841,92 pt, que es como Chrome redondea
el A4 al imprimir, para que los dos PDF sean del mismo tamaño.
