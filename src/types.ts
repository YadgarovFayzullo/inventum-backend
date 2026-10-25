export type ID = string

export type StudentStatus = 'active' | 'frozen' | 'left'

export interface Student {
  id: ID
  firstName: string
  lastName: string
  phone: string // 9 цифр без +998
  parentName: string
  parentPhone: string
  birthDate?: string
  source?: string
  note?: string
  status: StudentStatus
  discount: number // % скидки на все группы
  createdAt: string
  /** 0 — фото нет; растёт при каждой загрузке и входит в адрес картинки (кэш браузера) */
  photoVersion?: number
}

export interface Course {
  id: ID
  name: string
  price: number // базовая цена в месяц
  durationMonths: number
  description?: string
}

export interface Teacher {
  id: ID
  firstName: string
  lastName: string
  phone: string
  subject: string
  salaryPercent: number // % от оплат учеников его групп
  createdAt: string
}

export interface Group {
  id: ID
  name: string
  courseId: ID
  teacherId: ID
  days: number[] // ISO: 1 = Пн … 7 = Вс
  timeStart: string
  timeEnd: string
  room: string
  price: number // в месяц
  capacity: number
  startDate: string
  archived: boolean
}

/** Нахождение ученика в группе за период. Перевод = закрытие одного и открытие другого. */
export interface Enrollment {
  id: ID
  studentId: ID
  groupId: ID
  startDate: string
  endDate?: string // последний день в группе (включительно)
}

export interface Transfer {
  id: ID
  studentId: ID
  fromGroupId: ID
  toGroupId: ID
  date: string
  reason?: string
}

export type AttendanceMark = 'present' | 'absent' | 'late' | 'excused'

export type PaymentMethod = 'cash' | 'card' | 'click' | 'payme' | 'transfer'

export interface Payment {
  id: ID
  studentId: ID
  groupId: ID
  amount: number
  method: PaymentMethod
  date: string
  comment?: string
}

export type LeadStatus = 'new' | 'contacted' | 'trial' | 'won' | 'lost'

export interface Lead {
  id: ID
  name: string
  phone: string
  courseId?: ID
  source: string
  status: LeadStatus
  note?: string
  createdAt: string
}

export interface Settings {
  centerName: string
}
