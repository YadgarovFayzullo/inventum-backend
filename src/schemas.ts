import { z } from 'zod'

export const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const phone = z.string().regex(/^\d{0,9}$/)
const time = z.string().regex(/^\d{2}:\d{2}$/)
const money = z.number().int().min(0).max(100_000_000_000)

export const studentStatus = z.enum(['active', 'frozen', 'left'])
export const mark = z.enum(['present', 'absent', 'late', 'excused'])
export const method = z.enum(['cash', 'card', 'click', 'payme', 'transfer'])
export const leadStatus = z.enum(['new', 'contacted', 'trial', 'won', 'lost'])
export const role = z.enum(['owner', 'manager', 'teacher'])

export const student = z.object({
  id,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone,
  parentName: z.string().trim().max(120),
  parentPhone: phone,
  birthDate: date.optional(),
  source: z.string().max(60).optional(),
  note: z.string().max(2000).optional(),
  status: studentStatus,
  discount: z.number().int().min(0).max(100),
  createdAt: date,
})
// null в патче очищает необязательное поле (undefined в JSON просто пропадает)
export const studentPatch = student
  .omit({ id: true, createdAt: true, birthDate: true, source: true, note: true })
  .extend({ birthDate: date.nullable(), source: z.string().max(60).nullable(), note: z.string().max(2000).nullable() })
  .partial()

export const course = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  price: money,
  durationMonths: z.number().int().min(1).max(60),
  description: z.string().max(2000).optional(),
})
export const coursePatch = course.omit({ id: true, description: true }).extend({ description: z.string().max(2000).nullable() }).partial()

export const teacher = z.object({
  id,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone,
  subject: z.string().max(80),
  salaryPercent: z.number().int().min(0).max(100),
  createdAt: date,
})
export const teacherPatch = teacher.omit({ id: true, createdAt: true }).partial()

export const group = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  courseId: z.string().max(40),
  teacherId: z.string().max(40),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  timeStart: time,
  timeEnd: time,
  room: z.string().max(40),
  price: money,
  capacity: z.number().int().min(1).max(500),
  startDate: date,
  archived: z.boolean(),
})
export const groupPatch = group.omit({ id: true }).partial()

export const enrollment = z.object({ id, studentId: id, groupId: id, startDate: date, endDate: date.optional() })
export const transferRec = z.object({ id, studentId: id, fromGroupId: id, toGroupId: id, date, reason: z.string().max(300).optional() })
export const payment = z.object({
  id,
  studentId: id,
  groupId: id,
  amount: money.refine((n) => n > 0),
  method,
  date,
  comment: z.string().max(300).optional(),
})
export const lead = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  phone,
  courseId: z.string().max(40).optional(),
  source: z.string().max(60),
  status: leadStatus,
  note: z.string().max(2000).optional(),
  createdAt: date,
})
export const leadPatch = lead.omit({ id: true, createdAt: true, courseId: true, note: true }).extend({ courseId: z.string().max(40).nullable(), note: z.string().max(2000).nullable() }).partial()

export const importData = z.object({
  students: z.array(student),
  courses: z.array(course),
  teachers: z.array(teacher),
  groups: z.array(group),
  enrollments: z.array(enrollment),
  transfers: z.array(transferRec),
  attendance: z.record(z.string().regex(/^[A-Za-z0-9_-]+\|\d{4}-\d{2}-\d{2}\|[A-Za-z0-9_-]+$/), mark),
  payments: z.array(payment),
  leads: z.array(lead),
  settings: z.object({ centerName: z.string().trim().min(1).max(80) }),
})

export const password = z.string().min(8).max(200)
export const email = z.string().trim().toLowerCase().email().max(200)
