import crypto from 'node:crypto';
import { createPersistence } from '../persistence.mjs';
import { createResourceStore } from '../resource-store.mjs';

function verifyPassword(password, salt, expected) {
  try {
    const actual = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
    const wanted = Buffer.from(expected, 'hex');
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') {
    res.statusCode = 404;
    return res.end('Not found');
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const checks = {};
  let persistence;

  try {
    persistence = createPersistence({
      backend: 'postgres',
      databaseUrl: process.env.DATABASE_URL,
      dataDir: '/tmp/lykios-data',
      dbFile: '/tmp/lykios-data/db.json'
    });
    await persistence.init();

    checks.postgresHealth = await persistence.health();
    checks.stateExists = await persistence.exists();

    const loaded = await persistence.load();
    if (!loaded?.data) throw new Error('No persistent state found');

    const db = loaded.data;
    const users = Array.isArray(db.users) ? db.users : [];
    const courses = Array.isArray(db.courses) ? db.courses : [];
    const modules = Array.isArray(db.modules) ? db.modules : [];
    const lessons = Array.isArray(db.lessons) ? db.lessons : [];

    const admin = users.find(u => u.role === 'admin' && String(u.email).toLowerCase() === 'admin@lykiosacademy.com');
    checks.admin = {
      exists: Boolean(admin),
      active: admin?.status === 'active',
      passwordMatchesPreview: Boolean(admin && verifyPassword('AdminLykios2026!', admin.passwordSalt, admin.passwordHash))
    };

    const course = courses.find(c => c.slug === 'peeling-quimico-medicina-estetica' || c.slug === 'peeling-quimico');
    const courseModules = course ? modules.filter(m => m.courseId === course.id) : [];
    const courseLessons = course ? lessons.filter(l => l.courseId === course.id) : [];

    const danglingModules = modules.filter(m => !courses.some(c => c.id === m.courseId)).length;
    const danglingLessons = lessons.filter(l =>
      !courses.some(c => c.id === l.courseId) ||
      !modules.some(m => m.id === l.moduleId)
    ).length;

    const emails = users.map(u => String(u.email || '').toLowerCase()).filter(Boolean);
    const duplicateEmails = [...new Set(emails.filter((e, i) => emails.indexOf(e) !== i))];

    checks.database = {
      storageVersion: loaded.version,
      schemaVersion: db.meta?.schemaVersion ?? null,
      counts: {
        users: users.length,
        courses: courses.length,
        modules: modules.length,
        lessons: lessons.length,
        enrollments: Array.isArray(db.enrollments) ? db.enrollments.length : 0,
        sessions: Array.isArray(db.sessions) ? db.sessions.length : 0
      },
      duplicateEmails: duplicateEmails.length,
      danglingModules,
      danglingLessons
    };

    checks.peelingCourse = {
      exists: Boolean(course),
      title: course?.title || null,
      modules: courseModules.length,
      lessons: courseLessons.length,
      moduleCodes: courseModules.map(m => m.code).sort(),
      lessonCodes: courseLessons.map(l => l.code).sort()
    };

    try {
      const store = createResourceStore({ backend: 'blob', uploadDir: '/tmp/lykios-uploads' });
      await store.init();
      const name = 'diagnostic-' + Date.now() + '.txt';
      const ref = await store.save(name, Buffer.from('lykios-preview-ok'), 'text/plain');
      const read = await store.read(ref);
      const matched = read.toString() === 'lykios-preview-ok';
      await store.remove(ref);
      checks.blob = { backend: 'blob', write: true, read: matched, delete: true };
    } catch (e) {
      checks.blob = { backend: 'blob', ok: false, error: e?.message || String(e) };
    }

    const ok =
      checks.postgresHealth?.ok === true &&
      checks.stateExists === true &&
      checks.admin.exists &&
      checks.admin.active &&
      checks.admin.passwordMatchesPreview &&
      checks.database.danglingModules === 0 &&
      checks.database.danglingLessons === 0 &&
      checks.database.duplicateEmails === 0 &&
      checks.peelingCourse.exists &&
      checks.blob?.read === true;

    res.statusCode = ok ? 200 : 500;
    res.end(JSON.stringify({ ok, checks }, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok:false, error:e?.message || String(e), checks }, null, 2));
  } finally {
    try { await persistence?.close(); } catch {}
  }
}
