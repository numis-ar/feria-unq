# Instructivo: probar accesibilidad con Orca en Debian

Este documento explica cómo usar el lector de pantalla **Orca** en Debian para revisar manualmente que la aplicación web (`web/merchant.html`) sea usable por personas ciegas. El instructivo es agnóstico: funciona con Chrome, Firefox, Brave, Opera, Edge, y con cualquier entorno de escritorio (GNOME, XFCE, KDE, LXQt, etc.).

---

## 1. Instalación

```bash
sudo apt update
sudo apt install orca orca-scripts speech-dispatcher espeak-ng
```

Si querés una voz en español más natural, opcionalmente instalá también:

```bash
sudo apt install espeak-ng-data-espeak-ng-es  # voz en español
```

Verificá que Orca esté disponible:

```bash
orca --version
```

---

## 2. Iniciar Orca

### Desde el teclado (cualquier escritorio)

La combinación por defecto es:

- `Super + Alt + S`  
  (en algunos teclados `Super` es la tecla de Windows / Command).

Si no funciona, podés configurarla en los atajos de teclado de tu entorno de escritorio apuntando al comando `orca --replace --no-setup`.

### Desde la terminal

```bash
orca --replace --no-setup
```

- `--replace` reinicia Orca si ya estaba corriendo.
- `--no-setup` saltea el asistente inicial.

Para detenerlo:

```bash
orca --quit
```

---

## 3. Configuración rápida

### Asistente de configuración

```bash
orca --setup
```

Permite ajustar:

- velocidad de la voz,
- tono,
- teclado numérico como review cursor,
- activación/desactivación de braille,
- prefijo de teclas de Orca (por defecto `Orca Modifier = Insert` o `Caps Lock`).

### Preferencias en caliente

Con Orca activo, presioná:

- `Orca + Espacio` para abrir las preferencias generales.
- `Orca + Ctrl + Espacio` para las preferencias de la aplicación actual.

> `Orca` es la tecla modificadora configurada (`Insert` o `Caps Lock` por defecto).

---

## 4. Atajos esenciales para probar una web

Estos atajos funcionan en cualquier navegador y entorno de escritorio.

| Acción | Atajo |
|--------|-------|
| Activar/detener Orca | `Super + Alt + S` |
| Silenciar / reanudar voz | `Ctrl` |
| Leer toda la página | `Orca + A` |
| Siguiente elemento | `Tab` |
| Elemento anterior | `Shift + Tab` |
| Activar botón/enlace | `Enter` o `Espacio` |
| Siguiente encabezado | `H` |
| Encabezado anterior | `Shift + H` |
| Siguiente enlace | `K` |
| Enlace anterior | `Shift + K` |
| Siguiente campo de formulario | `F` |
| Campo anterior | `Shift + F` |
| Siguiente tabla | `T` |
| Tabla anterior | `Shift + T` |
| Siguiente landmark | `M` |
| Landmark anterior | `Shift + M` |
| Modo foco / modo revisión | `Orca + A` (alterna) |
| Listar enlaces | `Orca + K` |
| Listar encabezados | `Orca + H` |
| Listar formularios | `Orca + F` |
| Listar landmarks | `Orca + M` |

> En el modo revisión se usa el cursor para leer línea por línea (`↑`, `↓`, `←`, `→`).

---

## 5. Cómo probar `web/merchant.html`

### Preparar la app

1. Levantá el backend o el servidor mock:

   ```bash
   npm test
   ```

   o, si querés solo servir el frontend:

   ```bash
   npx serve web
   ```

2. Abrí la URL en tu navegador preferido (`http://localhost:.../merchant.html`).

3. Activá Orca con `Super + Alt + S`.

### Secuencia de prueba recomendada

1. **Login**
   - Navegá con `Tab` hasta el campo de usuario.
   - Verificá que Orca anuncie la etiqueta (`Usuario` / `Username`).
   - Completá usuario y contraseña y presioná `Enter`.
   - Escuchá el anuncio del loading (`Validando sesión…`).

2. **Dashboard**
   - Con `H` recorré los encabezados (`Panel de ventas`, `Vendido`, `En proceso`, etc.).
   - Con `Tab` verificá que los botones `(?)` tengan nombres descriptivos (`Ayuda sobre Vendido`, etc.).
   - Con `T` entrá a la tabla de pedidos y comprobá que anuncie encabezados de columna.

3. **Navegación**
   - Con `Tab` llegá al botón de navegación *Caja* / *Account*.
   - Presioná `Enter`.
   - Verificá que Orca anuncie el cambio de sección.

4. **Modales**
   - Abrí el modal de retiro o transferencia.
   - Con `Tab` comprobá que el foco no salga del modal.
   - Con `Esc` cerralo y verificá que el foco vuelva al botón que lo abrió.

5. **Formularios dentro de modales**
   - En el modal de transferencia, navegá alias → monto → confirmar con `Tab`.
   - Verificá que los botones en estado de carga anuncien "Procesando…".

6. **QR**
   - Al generar un retiro, verificá que se lean las instrucciones para same-device vs otro dispositivo.

---

## 6. Qué escuchar / observar

- **Landmarks:** al presionar `Orca + M` deberían aparecer `main`, `header`, `navigation` (sidebar), `navigation` (bottom dock).
- **Tablas:** al moverse entre celdas con `Ctrl + Alt + Flechas`, Orca debería anunciar el encabezado de columna correspondiente.
- **Modales:** el título del modal debería anunciarse al abrirse.
- **Estados de carga:** los botones con spinner deben anunciar "Procesando…".
- **Contraste y color:** aunque Orca no detecta contraste, si no distingue colores a simple vista con visión baja, reportalo como problema.

---

## 7. Solución de problemas

### Orca no habla

- Verificá el volumen y que el servicio de audio funcione:
  ```bash
  pactl info
  ```
- Probá otra voz:
  ```bash
  spd-say "hola"
  ```
- Reiniciá Orca:
  ```bash
  orca --quit && orca --replace --no-setup
  ```

### Atajos no funcionan en el navegador

- Algunos navegadores capturan ciertas teclas. Usá `Orca + Espacio` para cambiar al modo revisión/foco, o reasigná el modificador de Orca a `Caps Lock`.

### Orca lee demasiado contenido

- Reducí la verbosidad en `Orca + Espacio` → *Verbosidad*.
- Desactivá anuncios de formato si no son necesarios.

### En Brave/Opera no se escucha nada

- Asegurate de que el navegador no esté silenciado en el mezclador de audio del sistema.
- Probá primero con Firefox, que suele tener mejor integración con ATK/AT-SPI en Linux.

---

## 8. Reportar hallazgos

Si encontrás algo que no se anuncia correctamente, anotá:

1. Navegador y versión.
2. Entorno de escritorio.
3. Paso exacto para reproducirlo.
4. Lo que Orca anunció vs. lo que esperabas escuchar.

Con esa información podemos agregar o ajustar atributos ARIA, textos accesibles o anunciadores en `web/merchant.html`.
