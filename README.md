# 🧩 Puzzle Cooperativo

Rompecabezas multijugador en tiempo real. Entrás con un nickname, alguien sube una imagen,
el servidor genera las piezas (con pestañas aleatorias) y todos arman juntos viendo la
manito de los demás. El timer arranca cuando alguien toca la primera pieza y se detiene al completar.

**Stack:** Node.js + Express + Socket.IO. Sin base de datos: todo el estado vive en memoria.

## Correr localmente

```bash
npm install
npm start
```

Abrí http://localhost:3000 (en dos pestañas para probar el cooperativo).

## Cómo se juega

- **Arrastrar pieza:** clic/tocar y arrastrar. Si la soltás cerca de su lugar, encaja y queda fija.
- **Conectar piezas:** si soltás una pieza junto a su vecina correcta (aunque estén fuera del
  tablero), se unen y desde ahí se mueven como un solo grupo.
- **Puntos:** cada conexión entre piezas/grupos da 1 punto, y colocar una pieza o grupo en su
  lugar del tablero da 1 punto más. Se ven en la barra superior y al final hay un ranking.
  Se reinician con cada puzzle nuevo.
- **Mover la vista:** arrastrar el fondo. **Zoom:** rueda del mouse o pellizco en el celular.
- **⤢** recentra la vista. **Guía** muestra la imagen tenue dentro del tablero.
- **👁 Preview:** mantené presionado para ver la imagen completa a todo color; al soltar desaparece.
- **Bordes finos:** dibuja las piezas con un contorno casi invisible (se recuerda en tu navegador).
- **Ordenar:** acomoda todas las piezas y grupos sueltos alrededor del tablero, sin superponerse.
  Los grupos ya conectados y las piezas colocadas no se tocan. Afecta a todos los jugadores.
- **Salas privadas:** `https://tu-app/?sala=amigos` (sin `?sala` todos entran a la sala común).

## Cómo funciona

- `server.js`: mantiene las salas, jugadores y piezas. Genera la grilla (filas × columnas según
  el aspecto de la imagen), los bordes aleatorios compartidos entre piezas vecinas y la posición
  inicial esparcida fuera del tablero. Valida quién sostiene cada pieza (una persona a la vez),
  decide el encaje y controla el timer.
- `public/client.js`: dibuja todo en un `<canvas>`. Cada pieza se construye con curvas Bézier
  a partir de los bordes que manda el servidor y se pre-renderiza recortando la imagen.
- La imagen se reduce en el navegador (máx. 1600 px, JPEG) antes de subirse.

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
