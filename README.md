# 🧩 Puzzle Cooperativo

Rompecabezas multijugador en tiempo real. Entrás con un nickname, alguien sube una imagen,
el servidor genera las piezas (con pestañas aleatorias) y todos arman juntos viendo la
manito de los demás. El timer arranca cuando alguien toca la primera pieza y se detiene al completar.

**Stack:** Node.js + Express + Socket.IO. Sin base de datos: todo el estado vive en memoria.

## Correr localmente

```bash
npm install
PUZZLE_PASSWORD=mi-clave npm start
```

En PowerShell: `$env:PUZZLE_PASSWORD="mi-clave"; npm start`

Abrí http://localhost:3000 (en dos pestañas para probar el cooperativo).

## Cómo se juega

- **Arrastrar pieza:** clic/tocar y arrastrar. Si la soltás cerca de su lugar, encaja y queda fija.
- **Conectar piezas:** si soltás una pieza junto a su vecina correcta (aunque estén fuera del
  tablero), se unen y desde ahí se mueven como un solo grupo.
- **Puntos:** cada conexión entre piezas/grupos da 1 punto, y colocar una pieza o grupo en su
  lugar del tablero da 1 punto más. Se ven en la barra superior y al final hay un ranking.
  Se reinician con cada puzzle nuevo.
- **Mover la vista:** arrastrar el fondo. **Zoom:** rueda del mouse o pellizco en el celular.
- **En el celular:**
  - Tocá una pieza desde cualquier punto (hay tolerancia para el dedo) y arrastrala; al levantar
    el dedo se suelta. No hace falta doble toque.
  - Un dedo sobre el fondo mueve la vista; dos dedos hacen zoom y desplazan.
  - Solo se lleva una pieza a la vez: mientras arrastrás, los otros dedos no agarran nada. Si
    apoyás el segundo dedo enseguida, se entiende como pellizco y la pieza vuelve a su lugar.
  - Vibra al agarrar, al conectar y al encajar (en Android; iOS no permite vibrar desde la web).
  - Las herramientas están en el menú ☰. **Modo horizontal** rota toda la interfaz para jugar
    con el celular acostado (se recuerda en el dispositivo).
- **⤢** recentra la vista. **Guía** muestra la imagen tenue dentro del tablero.
- **👁 Preview:** mantené presionado para ver la imagen completa a todo color; al soltar desaparece.
- **Bordes finos:** dibuja las piezas con un contorno casi invisible (se recuerda en tu navegador).
- **Ordenar:** acomoda todas las piezas y grupos sueltos alrededor del tablero, sin superponerse.
  Los grupos ya conectados y las piezas colocadas no se tocan. Afecta a todos los jugadores.

## Cómo funciona

- `server.js`: mantiene las salas, jugadores y piezas. Genera la grilla (filas × columnas según
  el aspecto de la imagen), los bordes aleatorios compartidos entre piezas vecinas y la posición
  inicial esparcida fuera del tablero. Valida quién sostiene cada pieza (una persona a la vez),
  decide el encaje y controla el timer.
- `public/client.js`: dibuja todo en un `<canvas>`. Cada pieza se construye con curvas Bézier
  a partir de los bordes que manda el servidor y se pre-renderiza recortando la imagen.
- La imagen se reduce en el navegador (máx. 1600 px, JPEG) antes de subirse.

## Seguridad y privacidad

Hay una sola partida, protegida con contraseña:

- **Contraseña para entrar:** se configura con la variable de entorno `PUZZLE_PASSWORD`.
  Sin ella el servidor rechaza todas las conexiones. Quien no la sabe no recibe nada: ni la
  imagen, ni las piezas, ni los jugadores.
- **Anti fuerza bruta:** 5 intentos fallidos desde una misma IP la bloquean 15 minutos.
- **Imágenes cifradas:** cada navegador cifra la imagen con AES-GCM usando una clave derivada
  de la contraseña (PBKDF2). El servidor solo guarda y reenvía bytes cifrados, y los demás
  jugadores la descifran en su navegador. Además la imagen se recodifica antes de subirla, así
  que se pierden los metadatos EXIF (por ejemplo, la ubicación GPS).
- **En tránsito:** Render sirve todo por HTTPS/WSS.
- **Buscadores:** `robots.txt` y `X-Robots-Tag: noindex` evitan que la página se indexe.

Límites a tener en cuenta:
- Cualquiera que sepa la contraseña ve todo. Usá una larga (idealmente una frase) y cambiala
  en Render si se filtra.
- El servidor conoce la contraseña, así que en teoría podría derivar la clave. En la práctica
  solo guarda el cifrado.

### Configurarla en Render

Dashboard → tu servicio → **Environment** → **Add Environment Variable**:
`PUZZLE_PASSWORD` = tu contraseña. Guardá y Render redespliega solo. Para cambiar la
contraseña, editá esa variable.

## Hosting gratis

Necesitás un host que soporte **WebSockets** y un **proceso Node persistente**
(Vercel/Netlify/GitHub Pages **no** sirven porque son estáticos/serverless).

### Opción recomendada: Render (gratis)

1. Subí este proyecto a un repo de GitHub.
2. Entrá a https://render.com → **New → Blueprint** (usa `render.yaml`) o **New → Web Service**
   con: Build `npm install`, Start `npm start`, plan **Free**.
3. Te da una URL tipo `https://puzzle-coop.onrender.com` para compartir.

Limitaciones del plan gratis: se "duerme" tras 15 min sin visitas (la primera carga luego tarda
~30–60 s) y al reiniciarse se pierde el puzzle en curso (no hay DB, es esperable).

### Alternativas

- **Koyeb** (instancia free, soporta WebSockets): deploy desde GitHub, puerto por `PORT`.
- **Railway**: muy simple, ~US$5/mes de crédito; no se duerme.
- **Fly.io**: pago por uso, centavos al mes para una app así.
- **Para jugar ya desde tu PC:** `npm start` y luego `npx cloudflared tunnel --url http://localhost:3000`
  te da una URL pública temporal gratis (mientras tu PC esté prendida).
