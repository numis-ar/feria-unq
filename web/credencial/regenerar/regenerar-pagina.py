#!/usr/bin/env python3
"""
regenerar-pagina.py — Vuelve a armar ../credencial-a4.html a partir de plantilla.html.

Credencial para productorxs: hoja A4 con 2 credenciales (izquierda y derecha), cada una
con solapa M, cara B (invertida) y cara A. Cada credencial lleva su propio par
(QR, usuario), que se carga al usar la página o el script. Los textos fijos se definen
acá abajo.

Toda la hoja es un único dibujo SVG en milímetros. Los textos se guardan como trazos
(no como letras), así se ven idénticos en el navegador y en el PDF del script, sin
depender de tipografías instaladas. Este programa hace esa conversión.

Para cambiar textos, colores o medidas: editá CONFIGURACIÓN y ejecutá

    python3 regenerar-pagina.py

Requisitos en Debian 13:  sudo apt install python3-fonttools
No usa la red. Ver ../LEEME.md.
"""
import json
import math
import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
except ImportError:
    sys.exit("Falta fontTools. Instalalo con: sudo apt install python3-fonttools")

AQUI = Path(__file__).resolve().parent

# =============================================================================
# CONFIGURACIÓN — lo que normalmente vas a querer cambiar
# =============================================================================
# En los textos fijos, lo que va entre **dobles asteriscos** sale en negrita.

# --- Cara A (textos fijos; el QR y el usuario son datos de cada credencial) ---
A_INTRO = "Podés ingresar a tu cuenta con el usuario"          # va arriba del usuario
A_CLAVE = "Tenés que cambiar la contraseña la primera vez que ingreses."
URL_VISIBLE = "https://unq.numis.ar/productorxs"                # se lee debajo del QR

# --- Cara B: una entrada por bloque (se numeran solos) ---
B_BLOQUES = [
    "Recordá hacer el **cierre de la CAJA** al final de la Feria.",
    "Podés **bajarte la billetera** para vender y comprar en la Feria.",
    "El sistema de pago **no tiene valor fuera de la feria**.",
    "Más info en **https://unq.numis.ar**",
]

SOLAPA = "Solapa de base · doblar hacia adentro"     # texto gris de las solapas M

# --- Las dos credenciales de la hoja: nombre de cada lado y su x en la hoja ---
# Estos nombres los usan la página (#qr-izquierda=…) y el script (--izquierda QR USUARIO).
LADOS = [("izquierda", 0), ("derecha", 105)]

# --- Valores de ejemplo que muestra la página al abrirse ---
QR_DEFECTO = "https://unq.numis.ar/productorxs"
USUARIO_DEFECTO = "productorx.ejemplo"

# --- Usuario ---
USUARIO_MAX = 45                                     # máximo de caracteres (pedido)
USUARIO_PERMITIDOS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-@+"
USUARIO_CORTES = "._-@+"                             # si va en 2 renglones, se prefiere cortar después de estos

# Colores
VERDE = "#064d2d"        # fondo de las caras y color del QR
CREMA = "#f6f7f2"        # recuadro del usuario, círculos de la cara B
GUIA = "#a8a8a8"         # líneas de doblez y texto de las solapas
CORTE = "#d0d0d0"        # línea de corte entre las dos secciones
SEPARADOR = "#3d7357"    # líneas entre bloques de la cara B

FUENTES = {600: "fuentes/Montserrat-SemiBold.ttf", 700: "fuentes/Montserrat-Bold.ttf",
           800: "fuentes/Montserrat-ExtraBold.ttf", 900: "fuentes/Montserrat-Black.ttf"}

# =============================================================================
# MEDIDAS — en milímetros. Hoja A4 = 2 secciones de 105 mm de ancho; cada una:
#   solapa M (25) · cara B invertida (123,5) · cara A (123,5) · solapa M (25)
# Las coordenadas de cada cara son relativas a su esquina superior izquierda.
# =============================================================================
W, H, M, CARA = 105, 297, 25, 123.5
ANCHO_SEGURO = (5, W - 5)                            # aviso si un texto se sale de acá

# Cara A
A_TEXTO_PESO, A_TEXTO_TAM, A_INTERLINEA = 600, 3.6, 4.9
A_INTRO_BASE, A_INTRO_RENGLONES = 12.0, 1
USR_CAJA = (5, 16, 95, 24, 3)                        # recuadro del usuario: x, y, ancho, alto, radio
USR_MARGEN = 3                                       # aire a cada lado dentro del recuadro
USR_PESO = 800
USR_UNA_MAX, USR_UNA_MIN = 6.5, 4.0                  # 1 renglón: cuerpo máx.; si queda más chico que el mín. → 2 renglones
USR_DOS_MAX = 5.5                                    # 2 renglones: cuerpo máximo
USR_DOS_INTERLINEA = 1.25                            # 2 renglones: distancia entre líneas de base (en cuerpos)
USR_TAM_ABSOLUTO = 2.8                               # error si el peor caso de USUARIO_MAX queda más chico
A_CLAVE_BASE, A_CLAVE_RENGLONES = 47.5, 2
QR_CAJA = (27.5, 58, 50, 4)                          # recuadro blanco: x, y, lado, radio
QR_MARGEN = 4                                        # QR = 50 - 2*4 = 42 mm
URL_PESO, URL_TAM, URL_BASE = 700, 3.6, 115.5

# Cara B
B_ZONA = (5, 118.5)                                  # de dónde a dónde van los bloques (y)
B_CIRCULO_X, B_CIRCULO_R = 13, 4.6
B_NUM_PESO, B_NUM_TAM = 900, 4.8
B_TEXTO_X, B_TEXTO_ANCHO = 22, 78
B_PESO, B_PESO_NEGRITA, B_TAM, B_INTERLINEA = 600, 800, 4.0, 5.4

SOLAPA_PESO, SOLAPA_TAM, SOLAPA_BASE = 600, 2.6, 13.43

SALIDA = AQUI.parent / "credencial-a4.html"

# =============================================================================
# Fin de la configuración
# =============================================================================


def f(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def js(v):
    """Número escrito igual que String(v) en JavaScript (52.0 → "52")."""
    v = float(v)
    return str(int(v)) if v.is_integer() else repr(v)


# ---------- Tipografía: glifos, avances y kerning (tabla GPOS 'kern') ----------
class Fuente:
    def __init__(self, ruta):
        self.tt = TTFont(AQUI / ruta)
        self.upem = self.tt["head"].unitsPerEm
        self.cap = self.tt["OS/2"].sCapHeight
        self.cmap = self.tt.getBestCmap()
        self.hmtx = self.tt["hmtx"]
        self.gs = self.tt.getGlyphSet()
        self.lookups = []
        if "GPOS" in self.tt:
            gpos = self.tt["GPOS"].table
            indices = sorted({i for fr in gpos.FeatureList.FeatureRecord if fr.FeatureTag == "kern"
                              for i in fr.Feature.LookupListIndex})
            for i in indices:
                lk = gpos.LookupList.Lookup[i]
                subs = []
                for st in lk.SubTable:
                    tipo = lk.LookupType
                    if tipo == 9:
                        tipo, st = st.ExtensionLookupType, st.ExtSubTable
                    if tipo == 2:
                        subs.append(st)
                self.lookups.append(subs)

    def glifo(self, ch):
        try:
            return self.cmap[ord(ch)]
        except KeyError:
            sys.exit(f"Error: la fuente no tiene el carácter {ch!r}.")

    def avance(self, g):
        return self.hmtx[g][0]

    def kern(self, g1, g2):
        total = 0
        for subs in self.lookups:
            for st in subs:
                if g1 not in st.Coverage.glyphs:
                    continue
                if st.Format == 1:
                    ps = st.PairSet[st.Coverage.glyphs.index(g1)]
                    rec = next((r for r in ps.PairValueRecord if r.SecondGlyph == g2), None)
                    if rec is None:
                        continue
                    total += (getattr(rec.Value1, "XAdvance", 0) or 0) if rec.Value1 else 0
                    break
                if st.Format == 2:
                    c1 = st.ClassDef1.classDefs.get(g1, 0)
                    c2 = st.ClassDef2.classDefs.get(g2, 0)
                    v = st.Class1Record[c1].Class2Record[c2].Value1
                    total += (getattr(v, "XAdvance", 0) or 0) if v else 0
                    break
        return total

    def trazo(self, g, transformacion=None):
        pen = SVGPathPen(self.gs, ntos=f)
        self.gs[g].draw(TransformPen(pen, transformacion) if transformacion else pen)
        return pen.getCommands()


FUENTE = {peso: Fuente(ruta) for peso, ruta in FUENTES.items()}


# ---------- Texto fijo con ajuste de línea y **negritas** ----------
def letras(texto, peso, peso_negrita):
    salida, negrita = [], False
    for i, trozo in enumerate(texto.split("**")):
        if i:
            negrita = not negrita
        salida += [(ch, peso_negrita if negrita else peso) for ch in trozo]
    if negrita:
        sys.exit(f"Error: falta cerrar ** en {texto!r}")
    return salida


def medir(seq, tam):
    total, prev = 0.0, None
    for ch, peso in seq:
        fu = FUENTE[peso]
        g = fu.glifo(ch)
        if prev and prev[1] == peso:
            total += fu.kern(prev[0], g) * tam / fu.upem
        total += fu.avance(g) * tam / fu.upem
        prev = (g, peso)
    return total


def ajustar(texto, peso, peso_negrita, tam, ancho, nombre):
    seq = letras(texto, peso, peso_negrita)
    palabras, actual = [], []
    for c in seq:
        if c[0] == " ":
            if actual:
                palabras.append(actual)
            actual = []
        else:
            actual.append(c)
    if actual:
        palabras.append(actual)
    renglones, linea = [], []
    for p in palabras:
        prueba = linea + ([(" ", peso)] if linea else []) + p
        if linea and medir(prueba, tam) > ancho:
            renglones.append(linea)
            linea = p
        else:
            linea = prueba
    if linea:
        renglones.append(linea)
    for r in renglones:
        if medir(r, tam) > ancho + 1e-9:
            print(f"AVISO: en {nombre}, una palabra no entra en {ancho} mm: {''.join(c for c, _ in r)!r}")
    return renglones


def dibujar(seq, tam, x, base, alinear="center"):
    ancho = medir(seq, tam)
    x0 = {"center": x - ancho / 2, "left": x, "right": x - ancho}[alinear]
    d, cx, prev = [], x0, None
    for ch, peso in seq:
        fu = FUENTE[peso]
        g, k = fu.glifo(ch), tam / fu.upem
        if prev and prev[1] == peso:
            cx += fu.kern(prev[0], g) * k
        d.append(fu.trazo(g, (k, 0, 0, -k, cx, base)))
        cx += fu.avance(g) * k
        prev = (g, peso)
    return "".join(d), x0, x0 + ancho


def bloque(texto, peso, tam, base, max_renglones, nombre):
    renglones = ajustar(texto, peso, peso, tam, ANCHO_SEGURO[1] - ANCHO_SEGURO[0], nombre)
    if len(renglones) > max_renglones:
        print(f"AVISO: {nombre} ocupa {len(renglones)} renglones (lugar para {max_renglones}).")
    return "".join(dibujar(r, tam, W / 2, base + i * A_INTERLINEA)[0] for i, r in enumerate(renglones))


# ---------- Usuario: tabla compartida con la página y el script ----------
_FU = FUENTE[USR_PESO]
GLIFOS = {ch: {"a": _FU.avance(_FU.glifo(ch)), "d": _FU.trazo(_FU.glifo(ch))} for ch in USUARIO_PERMITIDOS}
KERN = {}
for _a in USUARIO_PERMITIDOS:
    for _b in USUARIO_PERMITIDOS:
        _k = _FU.kern(_FU.glifo(_a), _FU.glifo(_b))
        if _k:
            KERN[_a + _b] = _k

USR_ANCHO = USR_CAJA[2] - 2 * USR_MARGEN             # mm útiles
ESC_UNA_MAX, ESC_UNA_MIN = USR_UNA_MAX / _FU.upem, USR_UNA_MIN / _FU.upem
ESC_DOS_MAX = USR_DOS_MAX / _FU.upem
INTERLINEA_U = round(USR_DOS_INTERLINEA * _FU.upem)  # en unidades de la fuente


def peor_ancho(n):
    """Ancho máximo (unidades) de CUALQUIER usuario de n caracteres permitidos."""
    peor = {c: g["a"] for c, g in GLIFOS.items()}
    for _ in range(n - 1):
        peor = {c: max(peor[p] + KERN.get(p + c, 0) for p in GLIFOS) + GLIFOS[c]["a"] for c in GLIFOS}
    return max(peor.values())


# Garantía: con 2 renglones, el corte más parejo deja como mucho ceil(MAX/2) caracteres
# por renglón, así que el cuerpo nunca baja de este valor (aun con "WWWW…").
ESC_DOS_MIN = min(ESC_DOS_MAX, USR_ANCHO / peor_ancho(math.ceil(USUARIO_MAX / 2)))


def ancho(s):
    u, prev = 0, None
    for ch in s:
        if prev is not None:
            u += KERN.get(prev + ch, 0)
        u += GLIFOS[ch]["a"]
        prev = ch
    return u


def texto_usuario(usuario, lado):
    """El mismo armado que hacen la página (JS) y generar-credencial.py."""
    n, u = len(usuario), ancho(usuario)
    s = min(ESC_UNA_MAX, USR_ANCHO / u)
    if s >= ESC_UNA_MIN or n < 2:
        lineas = [(usuario, -_FU.cap / 2)]
    else:
        def mejor(cands):
            b = None
            for i in cands:
                m = max(ancho(usuario[:i]), ancho(usuario[i:]))
                if b is None or m < b[1]:
                    b = (i, m)
            return b
        todos = mejor(range(1, n))
        sep = mejor([i for i in range(1, n) if usuario[i - 1] in USUARIO_CORTES])
        corte = todos
        if sep and 5 * sep[1] <= 6 * todos[1] and min(ESC_DOS_MAX, USR_ANCHO / sep[1]) >= ESC_DOS_MIN:
            corte = sep
        s = min(ESC_DOS_MAX, USR_ANCHO / corte[1])
        i = corte[0]
        lineas = [(usuario[:i], INTERLINEA_U / 2 - _FU.cap / 2), (usuario[i:], -INTERLINEA_U / 2 - _FU.cap / 2)]
    x, y, w, h, _ = USR_CAJA
    partes = []
    for texto, ty in lineas:
        u, svg, prev = 0, [], None
        for ch in texto:
            if prev is not None:
                u += KERN.get(prev + ch, 0)
            g = GLIFOS[ch]
            if g["d"]:
                svg.append(f'<path transform="translate({u} 0)" d="{g["d"]}"/>')
            u += g["a"]
            prev = ch
        partes.append(f'<g transform="translate(-{js(u / 2)} {js(ty)})">' + "".join(svg) + "</g>")
    return (f'<g id="texto-usuario-{lado}" fill="{VERDE}" transform="translate({js(x + w / 2)} {js(y + h / 2)}) '
            f'scale({js(s)} -{js(s)})">' + "".join(partes) + "</g>")


# ---------- Formas ----------
def circulo_d(cx, cy, r):
    k = r * 0.5522847498   # curvas explícitas: se dibujan igual en todos los motores
    return (f"M{cx + r:.6f} {cy:.6f}C{cx + r:.6f} {cy + k:.6f} {cx + k:.6f} {cy + r:.6f} {cx:.6f} {cy + r:.6f}"
            f"C{cx - k:.6f} {cy + r:.6f} {cx - r:.6f} {cy + k:.6f} {cx - r:.6f} {cy:.6f}"
            f"C{cx - r:.6f} {cy - k:.6f} {cx - k:.6f} {cy - r:.6f} {cx:.6f} {cy - r:.6f}"
            f"C{cx + k:.6f} {cy - r:.6f} {cx + r:.6f} {cy - k:.6f} {cx + r:.6f} {cy:.6f}Z")


def rect_redondeado(x, y, w, h, r):
    k = r * 0.5522847498
    return (f"M{f(x + r)} {f(y)}H{f(x + w - r)}C{f(x + w - r + k)} {f(y)} {f(x + w)} {f(y + r - k)} {f(x + w)} {f(y + r)}"
            f"V{f(y + h - r)}C{f(x + w)} {f(y + h - r + k)} {f(x + w - r + k)} {f(y + h)} {f(x + w - r)} {f(y + h)}"
            f"H{f(x + r)}C{f(x + r - k)} {f(y + h)} {f(x)} {f(y + h - r + k)} {f(x)} {f(y + h - r)}"
            f"V{f(y + r)}C{f(x)} {f(y + r - k)} {f(x + r - k)} {f(y)} {f(x + r)} {f(y)}Z")


# ---------- Caras ----------
def cara_a_fija():
    ux, uy, uw, uh, ur = USR_CAJA
    qx, qy, ql, qr = QR_CAJA
    return "".join([
        f'<rect width="{W}" height="{CARA}" fill="{VERDE}"/>',
        f'<path fill="#fff" d="{bloque(A_INTRO, A_TEXTO_PESO, A_TEXTO_TAM, A_INTRO_BASE, A_INTRO_RENGLONES, "A_INTRO")}"/>',
        f'<path fill="{CREMA}" d="{rect_redondeado(ux, uy, uw, uh, ur)}"/>',
        f'<path fill="#fff" d="{bloque(A_CLAVE, A_TEXTO_PESO, A_TEXTO_TAM, A_CLAVE_BASE, A_CLAVE_RENGLONES, "A_CLAVE")}"/>',
        f'<path fill="#fff" d="{rect_redondeado(qx, qy, ql, ql, qr)}"/>',
        f'<path fill="#fff" d="{bloque(URL_VISIBLE, URL_PESO, URL_TAM, URL_BASE, 1, "URL_VISIBLE")}"/>',
    ])


def cara_b():
    y0, y1 = B_ZONA
    alto = (y1 - y0) / len(B_BLOQUES)
    partes = [f'<rect width="{W}" height="{CARA}" fill="{VERDE}"/>']
    fu_num = FUENTE[B_NUM_PESO]
    for i, txt in enumerate(B_BLOQUES):
        centro = y0 + alto * (i + 0.5)
        if i:
            partes.append(f'<path stroke="{SEPARADOR}" stroke-width="0.3" fill="none" '
                          f'd="M{f(B_TEXTO_X)} {f(y0 + alto * i)}H{f(ANCHO_SEGURO[1])}"/>')
        partes.append(f'<path fill="{CREMA}" d="{circulo_d(B_CIRCULO_X, centro, B_CIRCULO_R)}"/>')
        num, _, _ = dibujar([(str(i + 1), B_NUM_PESO)], B_NUM_TAM, B_CIRCULO_X,
                            centro + fu_num.cap * B_NUM_TAM / fu_num.upem / 2)
        partes.append(f'<path fill="{VERDE}" d="{num}"/>')
        renglones = ajustar(txt, B_PESO, B_PESO_NEGRITA, B_TAM, B_TEXTO_ANCHO, f"B_BLOQUES[{i}]")
        if len(renglones) * B_INTERLINEA > alto - 2:
            print(f"AVISO: B_BLOQUES[{i}] ocupa {len(renglones)} renglones y no entra en su espacio.")
        cap = FUENTE[B_PESO].cap * B_TAM / FUENTE[B_PESO].upem
        base0 = centro - (len(renglones) - 1) * B_INTERLINEA / 2 + cap / 2
        d = "".join(dibujar(r, B_TAM, B_TEXTO_X, base0 + j * B_INTERLINEA, "left")[0]
                    for j, r in enumerate(renglones))
        partes.append(f'<path fill="#fff" d="{d}"/>')
    return "".join(partes)


def armar_hoja():
    qx, qy, ql, _ = QR_CAJA
    lado_qr = ql - 2 * QR_MARGEN
    solapa, _, _ = dibujar(letras(SOLAPA, SOLAPA_PESO, SOLAPA_PESO), SOLAPA_TAM, W / 2, SOLAPA_BASE)
    defs = [f'<g id="cara-a-fija">{cara_a_fija()}</g>', f'<g id="cara-b">{cara_b()}</g>',
            f'<path id="solapa" fill="{GUIA}" d="{solapa}"/>']
    for nombre, _ in LADOS:
        defs.append(
            f'<g id="cara-a-{nombre}"><use href="#cara-a-fija" xlink:href="#cara-a-fija"/>'
            f'<g transform="translate({f(qx + QR_MARGEN)} {f(qy + QR_MARGEN)})">'
            f'<path id="qr-modulos-{nombre}" fill="{VERDE}" transform="scale(1)" d=""/></g>'
            f'{texto_usuario(USUARIO_DEFECTO, nombre)}</g>')
    partes = ["<defs>" + "".join(defs) + "</defs>", '<rect width="210" height="297" fill="#fff"/>']
    for nombre, x0 in LADOS:
        partes += [
            f'<use href="#solapa" xlink:href="#solapa" transform="rotate(180 {f(x0 + W/2)} {f(M/2)}) translate({f(x0)} 0)"/>',
            f'<use href="#cara-b" xlink:href="#cara-b" transform="rotate(180 {f(x0 + W/2)} {f(M + CARA/2)}) translate({f(x0)} {M})"/>',
            f'<use href="#cara-a-{nombre}" xlink:href="#cara-a-{nombre}" transform="translate({f(x0)} {f(M + CARA)})"/>',
            f'<use href="#solapa" xlink:href="#solapa" transform="translate({f(x0)} {f(M + 2*CARA)})"/>',
        ]
    partes.append(f'<g fill="none" stroke-width="0.25"><path stroke="{GUIA}" stroke-dasharray="1.2 0.9" '
                  f'd="M0 {M}H210M0 {f(M + CARA)}H210M0 {f(M + 2*CARA)}H210"/>'
                  f'<path stroke="{CORTE}" d="M105 0V297"/></g>')
    return ('<svg class="hoja-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'width="210mm" height="297mm" viewBox="0 0 210 297">' + "".join(partes) + "</svg>"), lado_qr


def main():
    if ESC_DOS_MIN * _FU.upem < USR_TAM_ABSOLUTO:
        sys.exit(f"Error: con USUARIO_MAX={USUARIO_MAX} el peor caso queda en "
                 f"{ESC_DOS_MIN * _FU.upem:.2f} mm (< {USR_TAM_ABSOLUTO} mm). Bajá USUARIO_MAX o agrandá USR_CAJA.")
    malos = [c for c in USUARIO_DEFECTO if c not in GLIFOS]
    if malos or not USUARIO_DEFECTO or len(USUARIO_DEFECTO) > USUARIO_MAX:
        sys.exit(f"Error: USUARIO_DEFECTO {USUARIO_DEFECTO!r} no es válido.")
    hoja, lado_qr = armar_hoja()
    x, y, w, h, _ = USR_CAJA
    usr_json = json.dumps({
        "glifos": GLIFOS, "kern": KERN, "max": USUARIO_MAX, "ancho": USR_ANCHO,
        "esc_una_max": ESC_UNA_MAX, "esc_una_min": ESC_UNA_MIN,
        "esc_dos_max": ESC_DOS_MAX, "esc_dos_min": ESC_DOS_MIN,
        "interlinea": INTERLINEA_U, "cap": _FU.cap, "cortes": USUARIO_CORTES,
        "cx": x + w / 2, "cy": y + h / 2, "verde": VERDE, "qr_lado": lado_qr,
        "lados": [n for n, _ in LADOS], "qr_defecto": QR_DEFECTO, "usuario_defecto": USUARIO_DEFECTO,
    }, ensure_ascii=False, separators=(",", ":"))
    html = (AQUI / "plantilla.html").read_text(encoding="utf-8")
    for marca, valor in {"__HOJA__": hoja, "__USR_JSON__": usr_json, "__USR_MAX__": str(USUARIO_MAX),
                         "__QRLIB__": (AQUI / "lib/qrcode.js").read_text(encoding="utf-8").strip()}.items():
        if marca not in html:
            sys.exit(f"Error: plantilla.html no tiene la marca {marca}.")
        html = html.replace(marca, valor)
    SALIDA.write_text(html, encoding="utf-8")
    print(f"Página generada: {SALIDA}")
    print(f"Credenciales: {', '.join(n for n, _ in LADOS)}.")
    print(f"Usuario: hasta {USUARIO_MAX} caracteres. 1 renglón entre {USR_UNA_MAX} y {USR_UNA_MIN} mm; "
          f"si no, 2 renglones entre {USR_DOS_MAX} y {ESC_DOS_MIN * _FU.upem:.2f} mm (peor caso garantizado).")


if __name__ == "__main__":
    main()
