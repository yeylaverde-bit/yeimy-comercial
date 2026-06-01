# Yeimy Comercial · Sistema interno de ventas

Sistema multi-usuario para Yeimy Laverde, vendedora independiente de motos
en el concesionario **Serviautec (Medellín)**.

## Funciones principales

- 💎 **Mis ventas** — KPIs, comisiones 5%, control pagadas/pendientes (admin)
- 💵 **Lista de precios** — Sheet en vivo de la empresa
- 📦 **Inventario disponible** — Sheet del concesionario (precio venta visible
  para asesores, costo solo para admin y contable)
- ✍️ **Ingresar lead / cliente** — registra venta y crea oportunidad en
  Impulsa CRM (vía API REST v2)
- 📋 **Mis registros del mes** — listado de leads ingresados
- 🔧 **Preasignación** — chasis específico → cliente, crédito, GPS
- 📑 **Orden de facturación** — sube 8 documentos (5 del asesor, 3 de contabilidad)
- 🛠️ **Taller** — motos en proceso, cambio de estado
- 📤 **Actualizar precios PDF** — admin sube PDF mensual de la empresa

## Roles

| Rol | Quién | Acceso |
|---|---|---|
| `admin` | Yeimy Laverde | Todo |
| `asesor` | Compañeros (Juan Pablo, Alejandra, Nathalia, Lorena, Miguel) | Operación diaria (sin Mis Ventas, sin Admin) |
| `contable` | Área contable Serviautec | Solo Orden Facturación (todos los asesores), Inventario, Precios |

## Stack

- **Backend:** Node.js + Express
- **Auth:** bcryptjs + express-session (cookie firmada)
- **Storage:** archivos JSON + filesystem (uploads)
- **Frontend:** HTML + CSS + JS vanilla (sin frameworks)
- **PWA:** manifest + service worker
- **Integración:** Impulsa CRM API REST v2 (Bearer auth)
- **Datos en vivo:** Google Sheets publicado como CSV

## Variables de entorno requeridas

Copiar `.env.example` a `.env` y llenar:

```
SESSION_SECRET=<base64 random 48 bytes>
IMPULSA_API_KEY=<Bearer token de Impulsa>
IMPULSA_ENV=test | prod
IMPULSA_ESTABLECIMIENTO=550026948
IMPULSA_USUARIO=yeimi
IMPULSA_CODIGO_DANE=05001
IMPULSA_ORIGEN=Venta Yeimy
IMPULSA_CAMPANNA=Venta directa redes Yeimy
HOST=0.0.0.0
PORT=3000
NODE_ENV=development
DATA_DIR=
```

## Correr local (Windows)

1. Doble clic a `iniciar.bat`
2. Abre navegador en http://localhost:3000

O manualmente:

```bash
npm install
npm start
```

## Deploy a Render.com

Ver [DEPLOY.md](DEPLOY.md) para pasos detallados.
