# Lykios Campus — despliegue Vercel

Dominio futuro: `https://campus.lykiosacademy.com`

## Estado actual
- Rama de pruebas: `preview`.
- No conectar el dominio final ni activar ventas reales hasta completar el Go/No-Go.
- PostgreSQL: Neon mediante `DATABASE_URL`.
- Recursos privados: Vercel Blob.
- Correo transaccional: Resend.
- Preview usa pagos de prueba; Production debe usar Stripe.

## Variables obligatorias

### Preview y Production
- `DATABASE_URL`
- `LYKIOS_VIDEO_SECRET` (mínimo 32 caracteres)
- `LYKIOS_ADMIN_EMAIL`
- `LYKIOS_ADMIN_PASSWORD`
- `RESEND_API_KEY`
- `BLOB_READ_WRITE_TOKEN`

### Solo Production
- `LYKIOS_APP_ORIGIN=https://campus.lykiosacademy.com`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

En Vercel, el backend esperado es PostgreSQL y el almacenamiento de archivos esperado es Blob.

## Preflight
No imprimir nunca valores de secretos. Los scripts solo informan nombres ausentes o reglas incumplidas.

```bash
npm run env:check:preview
npm run env:check:production
npm run preflight:vercel
```

Un resultado distinto de `GO` bloquea el despliegue.

## Salud y smoke test
Endpoints públicos:
- `/api/health/live`: proceso disponible.
- `/api/health/ready`: base de datos disponible y esquema legible.

Después de cada despliegue candidato:

```bash
npm run smoke -- https://URL-DEL-PREVIEW
```

Debe terminar en `SMOKE GO`.

## Backup del estado
El estado principal del LMS vive en PostgreSQL. Antes de cambios de producción importantes:

```bash
DATABASE_URL='...' npm run backup
```

El comando:
- exporta la fila de estado completa a `backups/`;
- genera un checksum SHA-256;
- crea archivos con permisos locales restrictivos;
- se niega a ejecutarse dentro de Vercel porque su filesystem es efímero.

`backups/` está ignorado por Git. No subir backups con datos de alumnos al repositorio.

Este backup cubre el estado PostgreSQL. Los binarios almacenados en Vercel Blob requieren una estrategia de respaldo separada si se decide conservar una segunda copia fuera del proveedor.

## Observabilidad
- Las peticiones generan logs estructurados con request ID, ruta, estado, duración e IP.
- Los fallos generan el evento `request_failed`.
- Los fallos de correo generan eventos `transactional_email_*`.
- Revisar 5xx y `/api/health/ready` antes de cada promoción a Production.

## Flujo de promoción a Production
1. Mantener `main/Production` sin cambios durante las pruebas de Preview.
2. Ejecutar backup.
3. Ejecutar preflight de Production.
4. Ejecutar smoke test en el deployment candidato.
5. Confirmar variables Stripe y webhook firmado.
6. Verificar correo, login, recuperación de contraseña, matrícula, progreso y certificado.
7. Ejecutar una prueba concurrente de checkout, progreso y envío de evaluaciones. Cualquier `STORAGE_CONFLICT` en estas rutas es NO-GO comercial.
8. Solo entonces asociar `campus.lykiosacademy.com`.
9. Ejecutar smoke test de nuevo sobre el dominio final.

## Seguridad
- No subir `.env`, backups ni credenciales al repositorio.
- Preview y Production deben usar credenciales distintas cuando sea posible.
- Las sesiones se almacenan hasheadas en PostgreSQL.
- La matrícula pagada solo se activa mediante confirmación de pago válida.
- TLS PostgreSQL se normaliza a `sslmode=verify-full`.
