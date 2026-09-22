# Lykios Campus — despliegue Vercel (coste mínimo)

Dominio futuro: `https://campus.lykiosacademy.com`

## Fase 1 — ahora, sin activar producción comercial
1. Crear un repositorio privado nuevo en GitHub: `lykios-campus`.
2. Subir el contenido de este paquete a la raíz del repositorio.
3. En Vercel: Add New → Project → importar `lykios-campus`.
4. Crear/conectar Neon Postgres al proyecto y comprobar que existe `DATABASE_URL` en Preview.
5. Crear/conectar Vercel Blob privado al proyecto.
6. Añadir en Preview: `LYKIOS_VIDEO_SECRET`, `LYKIOS_ADMIN_EMAIL`, `LYKIOS_ADMIN_PASSWORD`.
7. No poner claves Stripe Live en Preview.
8. Desplegar y comprobar `/api/health/live` y `/api/health/ready`.

## Fase 2 — cuando abramos ventas
1. Activar un plan de Vercel compatible con uso comercial.
2. Añadir las variables de Production, incluido `LYKIOS_APP_ORIGIN=https://campus.lykiosacademy.com`.
3. Añadir Stripe en modo producción y `STRIPE_WEBHOOK_SECRET`.
4. Asociar `campus.lykiosacademy.com` al proyecto.
5. Ejecutar el Go/No-Go completo antes de permitir compras.

## Seguridad
- No subir `.env` al repositorio.
- Preview y Production deben tener credenciales distintas cuando sea posible.
- La matrícula pagada solo se activa desde webhook firmado.

## Preflight automático

Con las variables de entorno ya presentes:

```bash
npm run preflight:vercel
```

En Preview debe terminar en `GO` sin exigir Stripe Live. En Production exige también las variables de Stripe.
