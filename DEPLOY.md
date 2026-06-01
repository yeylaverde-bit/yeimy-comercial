# 🚀 Guía de Deploy: Yeimy Comercial → Render + serviautec.com

## Estado actual
- ✅ Código preparado para Render (DATA_DIR, bootstrap, cookie HTTPS)
- ✅ `render.yaml` configurado (plan Starter + disco persistente 1GB)
- ✅ Git inicializado y primer commit hecho
- ⏳ Pendiente: subir a GitHub
- ⏳ Pendiente: crear servicio en Render
- ⏳ Pendiente: apuntar DNS de serviautec.com

## Paso 1: Crear el repositorio en GitHub (3 min)

1. Abre https://github.com/new (debe estar logueada como `yeylaverde-bit`)
2. **Repository name:** `yeimy-comercial`
3. **Privacy:** Selecciona **🔒 Private** (importante: contiene users.json con hashes)
4. **NO marques** "Initialize this repository with a README"
5. Clic **"Create repository"**

GitHub te muestra una página con comandos. Cópiame el primer bloque (que empieza con
`git remote add origin https://github.com/yeylaverde-bit/yeimy-comercial.git`).

## Paso 2: Conectar repo local al de GitHub (yo te ayudo)

Cuando me pases el comando del paso anterior, yo lo ejecuto en tu PC y subo el código.

Al hacer push GitHub te va a pedir autenticación. Opciones:
- **Más fácil (recomendado):** instala GitHub Desktop (https://desktop.github.com) y entras con tu cuenta. Después ejecutamos los comandos y se autentica solo.
- **Alternativa:** usas un Personal Access Token (te explico cuando llegue ese paso).

## Paso 3: Crear cuenta y servicio en Render (10 min)

### 3.1 Crear cuenta
1. Ve a https://dashboard.render.com/register
2. Clic en **"Sign up with GitHub"** (usará tu cuenta `yeylaverde-bit`)
3. Autoriza Render para acceder a tus repos

### 3.2 Crear Web Service
1. En el dashboard de Render, clic **"+ New"** → **"Web Service"**
2. Conecta tu repo `yeimy-comercial`
3. Render detectará el archivo `render.yaml` y mostrará la configuración automática:
   - Name: `yeimy-comercial`
   - Region: Ohio
   - Plan: Starter ($7/mes)
   - Disk: 1 GB persistente en `/data`
4. Clic **"Apply"** o **"Create Web Service"**

### 3.3 Configurar variables sensibles
En Settings → Environment, añade estas variables (las marqué con `sync: false` en render.yaml para que no estén en el repo):

| Variable | Valor |
|---|---|
| `SESSION_SECRET` | Genera una nueva con `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `IMPULSA_API_KEY` | La que te dio SPI (la actual o la rotada cuando llegue) |

Las demás (IMPULSA_ENV=prod, IMPULSA_ESTABLECIMIENTO, etc.) ya están en `render.yaml` y se configuran solas.

### 3.4 Disparar primer deploy
Clic en **"Manual Deploy"** → **"Deploy latest commit"**. Espera 3-5 minutos.

Cuando termine, Render te da una URL temporal tipo
`https://yeimy-comercial.onrender.com`. Abre esa URL y debe cargar el login.

## Paso 4: Apuntar serviautec.com → Render (5 min + propagación DNS)

### 4.1 En Render
1. Ve a tu Web Service → **Settings** → **Custom Domains**
2. Clic **"Add Custom Domain"**
3. Escribe `serviautec.com` (sin `https://`)
4. Render te dice qué registros DNS configurar. Algo así:
   - Tipo `A`: apunta a una IP de Render (te la dan ellos)
   - Tipo `CNAME` para `www`: apunta a `yeimy-comercial.onrender.com`

### 4.2 En el panel DNS de tu dominio
Entra a donde tienes registrado `serviautec.com` (GoDaddy, Namecheap, Cloudflare, etc.)
1. Ve a la sección **DNS**
2. Borra cualquier registro A o CNAME existente para `@` y `www`
3. Crea los registros que te dio Render
4. Guarda

### 4.3 Esperar propagación
Toma de 5 minutos a 24 horas. Mientras tanto el sitio sigue accesible en
`https://yeimy-comercial.onrender.com`.

Cuando propague, https://serviautec.com va a cargar tu dashboard con HTTPS (Render
emite el certificado SSL automáticamente).

## Paso 5: Avisar a los asesores

Cuando esté listo:

```
🏍️ Sistema interno Yeimy Comercial — ya está en línea:
   👉 https://serviautec.com

   Cuenta de cada uno (entrar con el correo personal asignado):
   - JUAN PABLO    Lpcipuc@gmail.com
   - ALEJANDRA    serviautecmotos101@gmail.com
   - NATHALIA     serviautecmotos104@gmail.com
   - LORENA       serviautecmotos111@gmail.com
   - MIGUEL       asesorexterno105@gmail.com
   - CONTABILIDAD Serviautecconcesionario@gmail.com

   Las claves temporales se mantienen igual.
   Al primer login el sistema te pide cambiarla.

   FUNCIONA DESDE CUALQUIER WIFI O DATOS MÓVILES.
   Se puede instalar como app en el celular ("Añadir a pantalla principal").
```

## Pendiente externo

- ⏳ Respuesta de SPI sobre asignación de Responsable en oportunidades por API
  (sigue siendo el bloqueo para que las ventas reales queden correctamente
  asignadas en Impulsa).

## Costos mensuales

| Concepto | Costo |
|---|---|
| Render Web Service Starter | $7 USD/mes |
| Render Persistent Disk 1GB | $0.25 USD/mes |
| **Total** | **~$7.25 USD/mes** (≈ $30.000 COP) |
| Dominio serviautec.com (anual) | $12-15 USD/año |
