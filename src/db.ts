import postgres from 'postgres'

export type Sql = postgres.Sql

/** Один пул на процесс. Суммы (bigint) приходят числами, даты (date) — строками 'YYYY-MM-DD', undefined пишется как NULL. */
export function connect(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
    transform: { undefined: null },
    types: {
      bigint: { to: 20, from: [20], parse: (v: string) => Number(v), serialize: (v: number) => String(v) },
      date: { to: 1082, from: [1082], parse: (v: string) => v, serialize: (v: string) => v },
    },
  })
}

/* Миграции: только добавляем новые элементы в конец списка, уже применённые не меняем */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','manager','teacher')),
    teacher_id text,
    name text NOT NULL,
    created_at date NOT NULL
  );
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at bigint NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_exp ON sessions(expires_at);

  CREATE TABLE courses (
    id text PRIMARY KEY, name text NOT NULL, price bigint NOT NULL CHECK (price >= 0),
    duration_months int NOT NULL, description text, seq bigserial
  );
  CREATE TABLE teachers (
    id text PRIMARY KEY, first_name text NOT NULL, last_name text NOT NULL, phone text NOT NULL,
    subject text NOT NULL, salary_percent int NOT NULL CHECK (salary_percent BETWEEN 0 AND 100),
    created_at date NOT NULL, seq bigserial
  );
  CREATE TABLE students (
    id text PRIMARY KEY, first_name text NOT NULL, last_name text NOT NULL, phone text NOT NULL,
    parent_name text NOT NULL, parent_phone text NOT NULL, birth_date date, source text, note text,
    status text NOT NULL CHECK (status IN ('active','frozen','left')),
    discount int NOT NULL DEFAULT 0 CHECK (discount BETWEEN 0 AND 100),
    created_at date NOT NULL,
    photo_version int NOT NULL DEFAULT 0,
    photo_type text,
    seq bigserial
  );
  CREATE INDEX students_created ON students(created_at DESC, seq DESC);
  CREATE TABLE groups (
    id text PRIMARY KEY, name text NOT NULL, course_id text NOT NULL, teacher_id text NOT NULL,
    days jsonb NOT NULL, time_start text NOT NULL, time_end text NOT NULL, room text NOT NULL,
    price bigint NOT NULL CHECK (price >= 0), capacity int NOT NULL CHECK (capacity > 0),
    start_date date NOT NULL, archived boolean NOT NULL DEFAULT false, seq bigserial
  );
  CREATE INDEX groups_teacher ON groups(teacher_id);
  CREATE TABLE enrollments (
    id text PRIMARY KEY,
    student_id text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    start_date date NOT NULL, end_date date
  );
  CREATE INDEX enrollments_group ON enrollments(group_id);
  CREATE INDEX enrollments_student ON enrollments(student_id);
  CREATE TABLE transfers (
    id text PRIMARY KEY,
    student_id text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    from_group_id text NOT NULL, to_group_id text NOT NULL, date date NOT NULL, reason text, seq bigserial
  );
  CREATE TABLE attendance (
    group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    date date NOT NULL,
    student_id text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    mark text NOT NULL CHECK (mark IN ('present','absent','late','excused')),
    PRIMARY KEY (group_id, date, student_id)
  );
  CREATE INDEX attendance_student ON attendance(student_id);
  CREATE TABLE payments (
    id text PRIMARY KEY,
    student_id text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    group_id text NOT NULL, amount bigint NOT NULL CHECK (amount > 0),
    method text NOT NULL CHECK (method IN ('cash','card','click','payme','transfer')),
    date date NOT NULL, comment text, seq bigserial
  );
  CREATE INDEX payments_student ON payments(student_id);
  CREATE INDEX payments_date ON payments(date DESC);
  CREATE TABLE leads (
    id text PRIMARY KEY, name text NOT NULL, phone text NOT NULL, course_id text, source text NOT NULL,
    status text NOT NULL CHECK (status IN ('new','contacted','trial','won','lost')),
    note text, created_at date NOT NULL, seq bigserial
  );
  CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
  `,
]

export async function migrate(sql: Sql) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  // advisory lock — чтобы два запущенных контейнера не мигрировали одновременно
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274)`
    const [{ v }] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM schema_migrations`
    for (let i = v; i < MIGRATIONS.length; i++) {
      await tx.unsafe(MIGRATIONS[i]!)
      await tx`INSERT INTO schema_migrations (version) VALUES (${i + 1})`
    }
  })
}
