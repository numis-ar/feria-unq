# Credenciales para productorxs (A4)

Una hoja A4 con **dos credenciales independientes**: la de la izquierda y la de la
derecha, cada una con **su propio QR y su propio usuario** (pensadas para dos
personas). Cada credencial es una "carpa" que se dobla en triángulo, igual que el
cartel QR:

```
 izquierda | derecha
 ----------+----------
 solapa M  | solapa M         ← se dobla hacia adentro (base)
 cara B    | cara B           ← invertida: queda derecha al doblar
 ----------+----------        ← doblez del vértice
 cara A    | cara A
 solapa M  | solapa M         ← se dobla hacia adentro (base)
```

- **Cara A:** "Podés ingresar a tu cuenta con el usuario", el **usuario** destacado,
  "Tenés que cambiar la contraseña la primera vez que ingreses.", el **QR** y debajo
  la URL `https://unq.numis.ar/productorxs`.
- **Cara B:** cuatro avisos numerados (cierre de caja, transferencias, validez del
  sistema de pago y más información). Es igual en las dos credenciales.

El QR y el usuario son los datos de cada credencial. Los textos fijos se cambian
regenerando la página (ver más abajo).

## Qué hay en esta carpeta

```
credencial/
├── credencial-a4.html         ← LA página. Fuente única para el navegador y para el script.
├── generar-credencial.py      ← Genera el PDF leyendo credencial-a4.html (sin red, sin Chrome).
├── LEEME.md                   ← Este instructivo.
└── regenerar/
    ├── regenerar-pagina.py    ← Configuración (textos, colores, medidas) + armado.
    ├── plantilla.html         ← Esqueleto de la página: estilos, panel y JavaScript.
    ├── fuentes/               ← Montserrat 600/700/800/900 (licencia OFL en OFL.txt).
    └── lib/qrcode.js          ← Generador de QR de la página (MIT, Kazuhiko Arase).
```

`credencial-a4.html` y `generar-credencial.py` tienen que estar en la **misma carpeta**
(o usá `--html RUTA` con el script).

## Requisitos (Debian 13)

```bash
sudo apt install weasyprint python3-qrcode     # para generar-credencial.py
sudo apt install python3-fonttools             # para regenerar/regenerar-pagina.py
```

Nada de esto usa la red.

## Uso diario

**Desde el navegador:** abrí `credencial-a4.html`. El panel tiene un bloque para la
**credencial izquierda** y otro para la **derecha**; en cada uno poné el QR (link o
texto) y el usuario. Después tocá *Imprimir* (A4, escala 100%, márgenes "ninguno",
gráficos de fondo activados). Si algún dato no es válido, *Imprimir* queda
deshabilitado y la página dice por qué.

También se puede abrir con los datos ya cargados:
`credencial-a4.html#qr-izquierda=QR1&usuario-izquierda=maria.gonzalez&qr-derecha=QR2&usuario-derecha=juan.perez`
(si la URL trae otros nombres, la página los ignora y lo avisa).

**Desde la terminal:** se pasan **exactamente dos pares**, uno por credencial, cada uno
con sus dos valores en orden: primero el QR, después el usuario.

```bash
./generar-credencial.py \
    --izquierda "https://unq.numis.ar/productorxs?u=maria" maria.gonzalez \
    --derecha   "https://unq.numis.ar/productorxs?u=juan"  juan.perez \
    -o credenciales.pdf
```

- Los dos pares son **obligatorios** y van **una sola vez** cada uno. El script corta
  con un error si falta uno, si se repite, si a un par le falta o le sobra un valor,
  si un QR está vacío o si un usuario no es válido (el error dice de qué lado es).
- Por defecto el PDF sale como `credenciales.pdf`.

## El usuario

- Hasta **45 caracteres**: letras sin tilde (se respetan mayúsculas y minúsculas),
  números y `. _ - @ +`. No admite espacios.
- **Un renglón** si entra a 4 mm o más (hasta 6,5 mm para usuarios cortos).
- Si no, **dos renglones** (hasta 5,5 mm). Se corta preferentemente después de
  `. _ - @ +` (por ejemplo `maria.fernanda.gonzalez.` / `rodriguez@feriaunq.ar`);
  si no hay un buen lugar, se corta donde los dos renglones queden más parejos.
- **Garantía:** con 45 caracteres entra *cualquier* usuario. El peor caso posible
  (45 "W") queda en dos renglones a 3,27 mm; un usuario real de 45 caracteres queda
  bastante más grande. La herramienta lo calcula al regenerar y da error si el peor
  caso quedara por debajo de 2,8 mm.

## Qué se puede cambiar y dónde

| Quiero cambiar…                                     | Dónde (`regenerar/regenerar-pagina.py`)          | ¿Hay que regenerar? |
|-----------------------------------------------------|--------------------------------------------------|---------------------|
| El QR o el usuario de cada credencial               | La página o `--izquierda` / `--derecha`          | No                  |
| Textos de la cara A                                 | `A_INTRO`, `A_CLAVE`, `URL_VISIBLE`              | **Sí**              |
| Los avisos de la cara B (agregar, quitar, editar)    | `B_BLOQUES` (lo que va entre `**…**` sale en negrita) | **Sí**         |
| Máximo de caracteres del usuario                    | `USUARIO_MAX`                                    | **Sí**              |
| Caracteres permitidos / dónde se prefiere cortar    | `USUARIO_PERMITIDOS`, `USUARIO_CORTES`           | **Sí**              |
| Tamaños del usuario (1 y 2 renglones)               | `USR_UNA_MAX`, `USR_UNA_MIN`, `USR_DOS_MAX`, `USR_TAM_ABSOLUTO` | **Sí** |
| Valores de ejemplo al abrir la página               | `QR_DEFECTO`, `USUARIO_DEFECTO`                  | **Sí**              |
| Colores, tamaños y posiciones                       | CONFIGURACIÓN y MEDIDAS                          | **Sí**              |
| Panel de la página, estilos de pantalla, JavaScript  | `regenerar/plantilla.html`                       | **Sí**              |

> **No edites `credencial-a4.html` a mano.** Se sobrescribe cada vez que regenerás.

## Cómo regenerar la página

```bash
cd regenerar
# editar regenerar-pagina.py (sección CONFIGURACIÓN)
python3 regenerar-pagina.py
```

Sobrescribe `../credencial-a4.html` e informa el máximo y los tamaños del usuario.
La página y `generar-credencial.py` ya usan lo nuevo (el script lee la página cada vez).

Los textos fijos se parten solos en renglones. Si algo no entra, avisa:

- `AVISO: A_CLAVE ocupa 3 renglones (lugar para 2).` → acortá el texto o ajustá
  `A_CLAVE_RENGLONES` y las posiciones de lo que viene debajo.
- `AVISO: B_BLOQUES[1] ocupa 4 renglones y no entra en su espacio.` → acortá ese
  aviso o usá menos bloques (el espacio se reparte entre los que haya).
- `Error: con USUARIO_MAX=… el peor caso queda en … mm` → bajá `USUARIO_MAX` o
  agrandá `USR_CAJA`.

## Detalles técnicos

**Textos como trazos.** Toda la hoja es un único SVG en milímetros y los textos se
guardan como dibujos de letras. Así el navegador y WeasyPrint dibujan exactamente
las mismas formas, sin depender de tipografías instaladas.

**Dos credenciales en la hoja.** Las partes fijas de la cara A (`cara-a-fija`) y la
cara B (`cara-b`) están una sola vez. Cada lado tiene su cara A (`cara-a-izquierda`,
`cara-a-derecha`) con su QR (`qr-modulos-…`) y su usuario (`texto-usuario-…`). Los
nombres de los lados salen de `LADOS` en `regenerar-pagina.py`, y de ahí los toman el
panel de la página, la URL y las opciones del script.

**El QR.** La página usa `lib/qrcode.js` (nivel de corrección M, modo byte UTF-8). El
script usa `python3-qrcode` con el mismo criterio para elegir la máscara, así que el
QR sale idéntico módulo a módulo.

**El usuario.** La página trae una tabla con el dibujo, el ancho y el kerning de cada
carácter permitido, más los tamaños y la regla de corte (`const USR = {...}` en el
HTML). La página (JavaScript) y el script (Python) arman el usuario con esa tabla y la
misma regla, así que salen idénticos.

**Lo que está escrito dos veces.** La *lógica* del QR y del armado del usuario (uno o
dos renglones, dónde cortar) existe en JavaScript (`plantilla.html`) y en Python
(`generar-credencial.py`). Los *datos* están una sola vez, en `credencial-a4.html`. Si
cambiás esa lógica en un lado, cambiala también en el otro.

**Verificación.** El PDF del navegador y el del script se compararon píxel por píxel a
600 dpi con: dos usuarios reales de 45 caracteres, el peor caso (45 "W") junto a uno
corto, y 45 "i" junto a uno típico. Difieren en 6 a 8 píxeles de 34,8 millones (bordes
suavizados). Los dos QR de cada hoja se leen con su texto correcto.

**Tamaño de hoja.** El script usa 594,96 × 841,92 pt, que es como Chrome redondea el A4
al imprimir, para que los dos PDF sean del mismo tamaño.
