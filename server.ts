import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json());

// ==================== CẤU TRÚC DỮ LIỆU & LƯU TRỮ GIÁO VIÊN ====================
export interface Teacher {
  id: string;
  name: string;
  gender: 'male' | 'female';
  school: string;
  subject: string;
  phone?: string;
  email?: string;
  password?: string;
  avatarSeed: string;
  createdAt: string;
}

export interface OtpSession {
  target: string; // phone or email
  type: 'phone' | 'email';
  code: string;
  expiresAt: number;
  action: 'register' | 'login';
}

const DATA_DIR = path.join(process.cwd(), 'data');
const TEACHERS_FILE = path.join(DATA_DIR, 'teachers.json');

const DEFAULT_TEACHERS: Teacher[] = [
  {
    id: 'teacher-1',
    name: 'Thầy Nguyễn Văn An',
    gender: 'male',
    school: 'Trường Tiểu học Chu Văn An',
    subject: 'math',
    phone: '0988123456',
    email: 'thayan.chuvanan@gmail.com',
    password: 'password123',
    avatarSeed: 'TeacherAn',
    createdAt: '2026-09-01T08:00:00.000Z'
  },
  {
    id: 'teacher-2',
    name: 'Cô Hoàng Thu Trang',
    gender: 'female',
    school: 'Trường Tiểu học Ánh Sáng',
    subject: 'vietnamese',
    phone: '0912345678',
    email: 'thutrang.anhsang@edu.vn',
    password: 'password123',
    avatarSeed: 'TeacherTrang',
    createdAt: '2026-09-02T08:00:00.000Z'
  }
];

// Bộ nhớ lưu phiên mã OTP (TTL 5 phút)
const otpStore = new Map<string, OtpSession>();

// Bộ nhớ token phiên đăng nhập
const sessionTokens = new Map<string, string>(); // token -> teacherId

function initDataStorage(): Teacher[] {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(TEACHERS_FILE)) {
      const raw = fs.readFileSync(TEACHERS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
    fs.writeFileSync(TEACHERS_FILE, JSON.stringify(DEFAULT_TEACHERS, null, 2), 'utf-8');
    return [...DEFAULT_TEACHERS];
  } catch (err) {
    console.error('[Storage Error] Failed to initialize teachers file:', err);
    return [...DEFAULT_TEACHERS];
  }
}

let teachersList: Teacher[] = initDataStorage();

function saveTeachersData(teachers: Teacher[]) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(TEACHERS_FILE, JSON.stringify(teachers, null, 2), 'utf-8');
    teachersList = teachers;
  } catch (err) {
    console.error('[Storage Error] Failed to save teachers:', err);
  }
}

function normalizePhone(phone?: string): string {
  if (!phone) return '';
  let cleaned = phone.replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('+84')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('84')) {
    cleaned = '0' + cleaned.slice(2);
  }
  return cleaned;
}

function normalizeEmail(email?: string): string {
  if (!email) return '';
  return email.trim().toLowerCase();
}

function isValidPhone(phone: string): boolean {
  const norm = normalizePhone(phone);
  return /^(03|05|07|08|09)\d{8}$/.test(norm);
}

function isValidEmail(email: string): boolean {
  const norm = normalizeEmail(email);
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(norm);
}

function sanitizeTeacher(t: Teacher) {
  const { password, ...rest } = t;
  return rest;
}

// ==================== CÁC ENDPOINT API DÀNH CHO GIÁO VIÊN ====================

// 1. Health Check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'ClassHero Teacher Auth Server',
    time: new Date().toISOString(),
    totalTeachers: teachersList.length
  });
});

// 2. Gửi mã OTP xác thực qua Email hoặc Số điện thoại
app.post('/api/auth/send-otp', (req: Request, res: Response) => {
  try {
    const { target, type, action = 'register' } = req.body;

    if (!target) {
      return res.status(400).json({
        success: false,
        error: 'Vui lòng cung cấp số điện thoại hoặc địa chỉ email để nhận mã xác thực.'
      });
    }

    let detectedType: 'phone' | 'email' = type;
    if (!detectedType) {
      detectedType = target.includes('@') ? 'email' : 'phone';
    }

    let normalizedTarget = '';
    if (detectedType === 'phone') {
      normalizedTarget = normalizePhone(target);
      if (!isValidPhone(normalizedTarget)) {
        return res.status(400).json({
          success: false,
          error: 'Số điện thoại không hợp lệ (cần đúng 10 số, đầu số 03, 05, 07, 08, 09).'
        });
      }
    } else {
      normalizedTarget = normalizeEmail(target);
      if (!isValidEmail(normalizedTarget)) {
        return res.status(400).json({
          success: false,
          error: 'Địa chỉ email không đúng định dạng (VD: giaovien@truong.edu.vn hoặc giaovien@gmail.com).'
        });
      }
    }

    // Kiểm tra tài khoản đã tồn tại hay chưa dựa vào mục đích gửi
    const existing = teachersList.find(t =>
      detectedType === 'phone'
        ? t.phone === normalizedTarget
        : t.email === normalizedTarget
    );

    if (action === 'register' && existing) {
      return res.status(409).json({
        success: false,
        error: `${detectedType === 'phone' ? 'Số điện thoại' : 'Địa chỉ email'} này đã được đăng ký bởi "${existing.name}". Vui lòng đăng nhập.`
      });
    }

    if (action === 'login' && !existing) {
      return res.status(404).json({
        success: false,
        error: `Không tìm thấy tài khoản giáo viên với ${detectedType === 'phone' ? 'số điện thoại' : 'email'} này. Vui lòng đăng ký tài khoản mới.`
      });
    }

    // Sinh mã ngẫu nhiên 6 số
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 phút

    const sessionKey = `${detectedType}:${normalizedTarget}`;
    otpStore.set(sessionKey, {
      target: normalizedTarget,
      type: detectedType,
      code: otpCode,
      expiresAt,
      action
    });

    // Mô phỏng quá trình chuyển tin nhắn SMS / Email
    if (detectedType === 'phone') {
      console.log(`\n========================================`);
      console.log(`[SMS GATEWAY - CLASSHERO]`);
      console.log(`Tới số điện thoại: ${normalizedTarget}`);
      console.log(`Nội dung: [ClassHero] Mã xác thực OTP của Thầy/Cô là: ${otpCode}. Mã có hiệu lực trong 5 phút.`);
      console.log(`========================================\n`);
    } else {
      console.log(`\n========================================`);
      console.log(`[SMTP EMAIL GATEWAY - CLASSHERO]`);
      console.log(`Tới Email: ${normalizedTarget}`);
      console.log(`Tiêu đề: [ClassHero] Mã xác thực đăng ký tài khoản Giáo viên`);
      console.log(`Nội dung: Kính gửi Quý Thầy/Cô, mã OTP để hoàn tất đăng ký là: ${otpCode}. Thời hạn 5 phút.`);
      console.log(`========================================\n`);
    }

    return res.json({
      success: true,
      message: `Mã xác thực OTP đã được gửi thành công đến ${detectedType === 'phone' ? 'số điện thoại SMS' : 'địa chỉ Email'} ${normalizedTarget}!`,
      target: normalizedTarget,
      type: detectedType,
      expiresInSeconds: 300,
      // Trong môi trường dev/preview, trả kèm otpCode để tiện trải nghiệm và hiển thị Banner thông báo
      otpCode
    });
  } catch (err: any) {
    console.error('[Send OTP Error]', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi gửi mã xác thực.' });
  }
});

// 3. Đăng ký tài khoản giáo viên mới thông qua Email hoặc Số điện thoại
app.post('/api/auth/register', (req: Request, res: Response) => {
  try {
    const {
      name,
      gender = 'male',
      school,
      subject = 'math',
      phone,
      email,
      otpCode,
      password
    } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập họ và tên Thầy/Cô.' });
    }

    const normPhone = phone ? normalizePhone(phone) : '';
    const normEmail = email ? normalizeEmail(email) : '';

    if (!normPhone && !normEmail) {
      return res.status(400).json({
        success: false,
        error: 'Vui lòng cung cấp ít nhất một phương thức liên lạc: Số điện thoại hoặc Địa chỉ Email.'
      });
    }

    if (normPhone && !isValidPhone(normPhone)) {
      return res.status(400).json({ success: false, error: 'Số điện thoại không hợp lệ (10 số, đầu 03, 05, 07, 08, 09).' });
    }

    if (normEmail && !isValidEmail(normEmail)) {
      return res.status(400).json({ success: false, error: 'Địa chỉ Email không đúng định dạng.' });
    }

    // Kiểm tra trùng lặp
    if (normPhone && teachersList.some(t => t.phone === normPhone)) {
      return res.status(409).json({ success: false, error: `Số điện thoại ${normPhone} đã tồn tại trong hệ thống.` });
    }
    if (normEmail && teachersList.some(t => t.email === normEmail)) {
      return res.status(409).json({ success: false, error: `Địa chỉ email ${normEmail} đã tồn tại trong hệ thống.` });
    }

    // Xác thực mã OTP
    if (!otpCode) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập mã xác thực OTP gửi về điện thoại hoặc email.' });
    }

    const targetKeyPhone = normPhone ? `phone:${normPhone}` : '';
    const targetKeyEmail = normEmail ? `email:${normEmail}` : '';

    const session =
      (targetKeyPhone && otpStore.get(targetKeyPhone)) ||
      (targetKeyEmail && otpStore.get(targetKeyEmail));

    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Không tìm thấy phiên gửi mã xác thực. Vui lòng bấm "Gửi Mã OTP" trước.'
      });
    }

    if (Date.now() > session.expiresAt) {
      otpStore.delete(session.type + ':' + session.target);
      return res.status(400).json({ success: false, error: 'Mã xác thực OTP đã hết hạn (5 phút). Vui lòng yêu cầu mã mới.' });
    }

    if (session.code !== otpCode.trim()) {
      return res.status(400).json({ success: false, error: 'Mã xác thực OTP không chính xác. Vui lòng kiểm tra lại.' });
    }

    // Xóa OTP sau khi dùng
    otpStore.delete(session.type + ':' + session.target);

    // Kiểm tra mật khẩu
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Mật khẩu phải có tối thiểu 6 ký tự.' });
    }

    // Tạo giáo viên mới
    const newTeacher: Teacher = {
      id: `teacher-${Date.now()}`,
      name: name.trim(),
      gender: gender === 'female' ? 'female' : 'male',
      school: school ? school.trim() : 'Trường Tiểu học & THCS',
      subject: subject || 'math',
      phone: normPhone || undefined,
      email: normEmail || undefined,
      password: password,
      avatarSeed: encodeURIComponent(name.trim()),
      createdAt: new Date().toISOString()
    };

    teachersList.push(newTeacher);
    saveTeachersData(teachersList);

    // Tạo token phiên đăng nhập
    const token = `token_${newTeacher.id}_${Date.now()}`;
    sessionTokens.set(token, newTeacher.id);

    return res.status(201).json({
      success: true,
      message: `Đăng ký tài khoản giáo viên thành công! Chào mừng ${newTeacher.name}.`,
      teacher: sanitizeTeacher(newTeacher),
      token
    });
  } catch (err: any) {
    console.error('[Register Error]', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi đăng ký tài khoản.' });
  }
});

// 4. Đăng nhập dành cho giáo viên (hỗ trợ cả Email và Số điện thoại)
app.post('/api/auth/login', (req: Request, res: Response) => {
  try {
    const { identifier, password, otpCode, loginMethod = 'password' } = req.body;

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'Vui lòng nhập số điện thoại hoặc địa chỉ email đã đăng ký.'
      });
    }

    const normPhone = normalizePhone(identifier);
    const normEmail = normalizeEmail(identifier);

    // Tìm giáo viên theo phone hoặc email
    const teacher = teachersList.find(t =>
      (t.phone && t.phone === normPhone) ||
      (t.email && t.email.toLowerCase() === normEmail)
    );

    if (!teacher) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy tài khoản giáo viên với thông tin đăng nhập này.'
      });
    }

    if (loginMethod === 'password') {
      if (!password || teacher.password !== password) {
        return res.status(401).json({
          success: false,
          error: 'Mật khẩu không chính xác! Vui lòng thử lại hoặc chọn đăng nhập qua mã OTP.'
        });
      }
    } else {
      // Đăng nhập bằng mã OTP
      const keyPhone = teacher.phone ? `phone:${teacher.phone}` : '';
      const keyEmail = teacher.email ? `email:${teacher.email}` : '';

      const session =
        (keyPhone && otpStore.get(keyPhone)) ||
        (keyEmail && otpStore.get(keyEmail));

      if (!session) {
        return res.status(400).json({
          success: false,
          error: 'Vui lòng nhấn "Gửi Mã OTP" để nhận mã xác thực đăng nhập trước.'
        });
      }

      if (Date.now() > session.expiresAt) {
        return res.status(400).json({ success: false, error: 'Mã OTP đã hết hiệu lực.' });
      }

      if (session.code !== (otpCode || '').trim()) {
        return res.status(400).json({ success: false, error: 'Mã xác thực OTP không chính xác.' });
      }

      otpStore.delete(session.type + ':' + session.target);
    }

    const token = `token_${teacher.id}_${Date.now()}`;
    sessionTokens.set(token, teacher.id);

    return res.json({
      success: true,
      message: `Chào mừng ${teacher.name} đã đăng nhập thành công!`,
      teacher: sanitizeTeacher(teacher),
      token
    });
  } catch (err: any) {
    console.error('[Login Error]', err);
    return res.status(500).json({ success: false, error: 'Lỗi máy chủ khi đăng nhập.' });
  }
});

// 5. Lấy thông tin tài khoản hiện tại
app.get('/api/auth/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.token as string);

  if (!token || !sessionTokens.has(token)) {
    // Nếu có ít nhất 1 giáo viên, trả về giáo viên đầu tiên để trải nghiệm dev mượt mà
    if (teachersList.length > 0) {
      return res.json({
        success: true,
        authenticated: false,
        defaultTeacher: sanitizeTeacher(teachersList[0])
      });
    }
    return res.status(401).json({ success: false, error: 'Chưa đăng nhập.' });
  }

  const teacherId = sessionTokens.get(token);
  const teacher = teachersList.find(t => t.id === teacherId);

  if (!teacher) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy giáo viên.' });
  }

  return res.json({
    success: true,
    authenticated: true,
    teacher: sanitizeTeacher(teacher)
  });
});

// 6. Cập nhật hồ sơ giáo viên
app.put('/api/auth/profile', (req: Request, res: Response) => {
  const { id, name, school, subject, phone, email } = req.body;

  if (!id) {
    return res.status(400).json({ success: false, error: 'Thiếu mã giáo viên (id).' });
  }

  const idx = teachersList.findIndex(t => t.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy giáo viên.' });
  }

  const current = teachersList[idx];
  if (name) current.name = name.trim();
  if (school) current.school = school.trim();
  if (subject) current.subject = subject;
  if (phone) current.phone = normalizePhone(phone);
  if (email) current.email = normalizeEmail(email);
  if (name) current.avatarSeed = encodeURIComponent(name.trim());

  teachersList[idx] = current;
  saveTeachersData(teachersList);

  return res.json({
    success: true,
    message: 'Cập nhật thông tin giáo viên thành công!',
    teacher: sanitizeTeacher(current)
  });
});

// 7. Danh sách giáo viên mẫu / đang có trong hệ thống
app.get('/api/teachers', (req: Request, res: Response) => {
  res.json({
    success: true,
    teachers: teachersList.map(sanitizeTeacher)
  });
});

// ==================== KHỞI CHẠY SERVER & TÍCH HỢP VITE ====================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ClassHero Server] Đang hoạt động trên cổng http://0.0.0.0:${PORT}`);
    console.log(`[ClassHero Server] Đã nạp ${teachersList.length} tài khoản giáo viên.`);
  });
}

startServer();
