require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const nodemailer = require('nodemailer');

const DEPARTMENTS = ['FPS', 'FMS', 'FLA', 'FOL', 'FST'];
const DEPARTMENT_DETAILS = {
  FPS: { name: 'Faculty of Pharmaceutical Sciences', short: 'FPS', color: '#d97706', bg: '#fef3c7', icon: '💊' },
  FMS: { name: 'Faculty of Management Studies', short: 'FMS', color: '#059669', bg: '#d1fae5', icon: '📊' },
  FLA: { name: 'Faculty of Liberal Arts', short: 'FLA', color: '#7c3aed', bg: '#ede9fe', icon: '🎨' },
  FOL: { name: 'Faculty of Law', short: 'FOL', color: '#dc2626', bg: '#fee2e2', icon: '⚖️' },
  FST: { name: 'Faculty of Science & Technology', short: 'FST', color: '#0284c7', bg: '#e0f2fe', icon: '💻' },
};

const SAMPLE_RESUME = 'https://www.iuraipur.edu.in/FacultyImages/BMMrRk0yTwAmYW7ALh2azX6dRSN4HKvGFvzaGPVNrg47UO6pQZSnEExe0dATi8.pdf';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const getMailTransporter = () => {
  const emailUser = process.env.EMAIL_USER || 'yogender@iuhimachal.edu.in';
  const emailPass = (process.env.EMAIL_PASS || process.env.Email_PASS || '').replace(/\s+/g, '');

  if (!emailPass) {
    throw new Error('EMAIL_PASS is missing in environment variables. Please add EMAIL_PASS to your .env or cloud deployment settings.');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPass,
    },
  });
};

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  otp: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // 10 minutes auto-expiration
});
const Otp = mongoose.models.Otp || mongoose.model('Otp', otpSchema);

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  department: { type: String, enum: DEPARTMENTS, required: true },
  contact: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  joiningDate: { type: Date, required: true },
  designation: { type: String, trim: true, default: 'Faculty Member' },
  highestQualification: { type: String, trim: true, default: 'Post-Graduate' },
  photoUrl: { type: String, default: '' },
  resumeUrl: { type: String, default: '' },
  resumeData: {
    data: Buffer,
    contentType: { type: String, default: 'application/pdf' },
    filename: { type: String, default: 'resume.pdf' },
  },
  lastAlert: {
    alertType: { type: String, default: '' },
    sentAt: { type: Date },
    message: { type: String, default: '' },
  },
}, { timestamps: true });

const Employee = mongoose.models.Employee || mongoose.model('Employee', employeeSchema);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files from both public and workspace root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Ensure database-backed API routes wait for MongoDB, including on Vercel.
app.use('/api', async (req, res, next) => {
  if (['/admin/login', '/admin/logout', '/admin/me'].includes(req.path)) {
    return next();
  }

  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    res.status(500).json({ error: 'Database connection failed: ' + err.message });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Helper to stream upload buffers to Cloudinary
const toCloud = (buffer, opts) => new Promise((resolve, reject) => {
  cloudinary.uploader.upload_stream(opts, (err, res) => (err ? reject(err) : resolve(res))).end(buffer);
});

// Helper to upload PDF resume to Cloudinary
const uploadResumeToCloudinary = async (buffer, facultyName) => {
  const cleanName = (facultyName || 'faculty').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const uniqueId = Date.now() + '_' + Math.round(Math.random() * 1e4);
  const publicId = `${cleanName}_resume_${uniqueId}.pdf`;

  const result = await toCloud(buffer, {
    folder: 'employee-portal/resumes',
    resource_type: 'raw',
    public_id: publicId,
  });
  return result.secure_url;
};

// Helper to extract Cloudinary public_id and delete from Cloudinary
const deleteFromCloudinary = async (url) => {
  if (!url || typeof url !== 'string' || !url.includes('cloudinary.com') || url === SAMPLE_RESUME) {
    return;
  }
  try {
    const isRaw = url.includes('/raw/upload/');
    let publicId = '';
    if (isRaw) {
      // In Cloudinary raw storage, the filename extension (.pdf) is part of the public_id
      const match = url.match(/\/raw\/upload\/(?:v\d+\/)?(.+?)$/);
      if (match && match[1]) {
        publicId = decodeURIComponent(match[1]);
      }
    } else {
      const match = url.match(/\/(?:image|video)\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
      if (match && match[1]) {
        publicId = decodeURIComponent(match[1]);
      }
    }

    if (publicId) {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: isRaw ? 'raw' : 'image',
        invalidate: true,
      });
      console.log(`Cloudinary asset destroyed: ${publicId} (${isRaw ? 'raw' : 'image'})`);
    }
  } catch (err) {
    console.warn(`Cloudinary destroy warning for ${url}:`, err.message);
  }
};

// ---------- Auth middleware ----------
const requireAdmin = (req, res, next) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace(/^Bearer\s+/, '');
    if (!token) throw new Error('No token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iuhp-jwt-secret-key-2026');
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Admin authentication required' });
  }
};

// Admin Auth routes
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const validUser = 'admin';
  const validPass = 'qwerty@123';

  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { role: 'admin', username },
    process.env.JWT_SECRET || 'iuhp-jwt-secret-key-2026',
    { expiresIn: '30d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000, // 30 days
  });

  res.json({ ok: true, username });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true, admin: req.admin });
});

// ---------- Public Directory Endpoint ----------
// Anyone can view all departments and faculty profiles, but cannot edit or export
app.get('/api/public/employees', async (req, res) => {
  try {
    const employees = await Employee.find({})
      .select('name department designation highestQualification contact email joiningDate photoUrl resumeUrl resumeData.data')
      .sort({ department: 1, name: 1 })
      .lean();

    const formattedEmployees = employees.map((emp) => {
      let resumeUrl = emp.resumeUrl || '';
      // Backward compatibility: If resume is stored in MongoDB buffer, point to resume.pdf route
      if (!resumeUrl && emp.resumeData?.data) {
        resumeUrl = `/api/public/employees/${emp._id}/resume.pdf`;
      }
      return {
        _id: emp._id,
        name: emp.name,
        department: emp.department,
        designation: emp.designation,
        highestQualification: emp.highestQualification,
        contact: emp.contact,
        email: emp.email,
        joiningDate: emp.joiningDate,
        photoUrl: emp.photoUrl || '',
        resumeUrl,
      };
    });

    res.json({
      departments: DEPARTMENTS,
      departmentDetails: DEPARTMENT_DETAILS,
      employees: formattedEmployees,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch directory: ' + err.message });
  }
});

// Direct inline streaming route for resumes
// Handles Cloudinary URLs (redirect) and legacy MongoDB buffers (streaming)
app.get('/api/public/employees/:id/resume.pdf', async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).send('Faculty record not found.');

    // 1. If stored on Cloudinary or external URL, redirect directly
    if (emp.resumeUrl && emp.resumeUrl.startsWith('http')) {
      return res.redirect(emp.resumeUrl);
    }

    // 2. Legacy fallback: If already uploaded & stored in MongoDB buffer, stream inline
    if (emp.resumeData?.data) {
      res.setHeader('Content-Type', emp.resumeData.contentType || 'application/pdf');
      const safeFilename = `${(emp.name || 'Faculty').replace(/[^a-zA-Z0-9_-]/g, '_')}_Resume.pdf`;
      res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
      return res.send(emp.resumeData.data);
    }

    return res.status(404).send('No resume uploaded for this faculty member yet.');
  } catch (err) {
    res.status(500).send('Error retrieving resume: ' + err.message);
  }
});

// Lookup existing faculty by email (for self-service profile autofill & resume status check)
app.get('/api/public/faculty/lookup', async (req, res) => {
  try {
    const email = req.query.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email parameter is required' });

    const emp = await Employee.findOne({ email }).lean();
    if (!emp) return res.json({ found: false });

    // Exclude foreign sample URLs so users are only shown their real resume
    let cleanResume = (emp.resumeUrl && emp.resumeUrl !== SAMPLE_RESUME) ? emp.resumeUrl : '';
    // Backward compatibility for existing MongoDB buffer records
    if (!cleanResume && emp.resumeData?.data) {
      cleanResume = `/api/public/employees/${emp._id}/resume.pdf`;
    }

    res.json({
      found: true,
      employee: {
        id: emp._id,
        name: emp.name,
        department: emp.department,
        designation: emp.designation,
        highestQualification: emp.highestQualification,
        contact: emp.contact,
        email: emp.email,
        joiningDate: emp.joiningDate ? emp.joiningDate.toISOString().slice(0, 10) : '',
        photoUrl: emp.photoUrl || '',
        resumeUrl: cleanResume,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Public OTP Endpoints (100% Free Email OTP via Nodemailer) ----------
// 1. Send OTP to Official Faculty Email
app.post('/api/public/otp/send', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !email.trim() || !email.includes('@')) {
      return res.status(400).json({ error: 'Please provide a valid official email address.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Generate secure 6-digit random code
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save/Upsert OTP in database with 10-minute expiration
    await Otp.deleteMany({ email: cleanEmail });
    await Otp.create({ email: cleanEmail, otp: otpCode });

    // Send professional IUHP branded email
    const mailOptions = {
      from: `"IUHP Faculty Portal" <${process.env.EMAIL_USER || 'yogender@iuhimachal.edu.in'}>`,
      to: cleanEmail,
      subject: `IUHP Faculty Verification Code: ${otpCode}`,
      html: `
        <div style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,0.06);">
          <div style="background:linear-gradient(135deg, #0f4c5c 0%, #1e293b 100%); padding:24px 20px; text-align:center; color:#ffffff;">
            <h2 style="margin:0; font-size:20px; font-weight:700; letter-spacing:0.5px;">THE ICFAI UNIVERSITY</h2>
            <div style="font-size:12px; color:#e09f3e; font-weight:700; margin-top:4px; letter-spacing:1px;">HIMACHAL PRADESH • FACULTY PORTAL</div>
          </div>
          <div style="padding:32px 24px; color:#334155;">
            <h3 style="margin:0 0 10px; font-size:18px; color:#0f172a; font-weight:700;">Faculty Profile Verification</h3>
            <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#64748b;">
              Please use the verification code below to authorize your faculty profile registration or details update.
            </p>
            <div style="background:#f8fafc; border:2px dashed #0f4c5c; border-radius:10px; padding:20px; text-align:center; margin:24px 0;">
              <div style="font-size:11px; color:#64748b; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Your 6-Digit Verification Code</div>
              <span style="font-size:34px; font-weight:800; letter-spacing:8px; color:#0f4c5c; font-family:'Courier New', monospace; display:inline-block; margin-left:8px;">${otpCode}</span>
            </div>
            <p style="margin:0; font-size:13px; color:#94a3b8; text-align:center; line-height:1.5;">
              ⏰ This code expires in <strong>10 minutes</strong>.<br>If you did not request this verification, you can safely ignore this email.
            </p>
          </div>
          <div style="background:#f1f5f9; padding:14px 24px; text-align:center; font-size:12px; color:#94a3b8; border-top:1px solid #e2e8f0;">
            © 2026 The ICFAI University, Himachal Pradesh. All rights reserved.
          </div>
        </div>
      `,
    };

    const mailTransporter = getMailTransporter();
    await mailTransporter.sendMail(mailOptions);

    res.json({
      ok: true,
      message: `A 6-digit verification OTP has been sent to ${cleanEmail}. Please check your inbox or spam folder.`,
    });
  } catch (err) {
    console.error('Failed to send OTP email:', err);
    res.status(500).json({ error: 'Failed to send OTP email: ' + (err.message || 'Please check email configuration') });
  }
});

// 2. Verify OTP
app.post('/api/public/otp/verify', async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit OTP code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.trim();

    const record = await Otp.findOne({ email: cleanEmail, otp: cleanOtp });
    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please check the code or request a new one.' });
    }

    // Generate verification token (valid for 30 minutes)
    const otpToken = jwt.sign(
      { email: cleanEmail, verified: true, type: 'email_otp' },
      process.env.JWT_SECRET || 'iuhp-jwt-secret-key-2026',
      { expiresIn: '30m' }
    );

    // Delete used OTP
    await Otp.deleteMany({ email: cleanEmail });

    res.json({
      ok: true,
      otpToken,
      message: 'Email successfully verified!',
    });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: err.message || 'Failed to verify OTP' });
  }
});

// ---------- Public Faculty Self-Service Submission Endpoint ----------
// Faculty members themselves can register / add their profile individually
app.post(
  '/api/public/faculty',
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'resume', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { name, department, contact, email, joiningDate, designation, highestQualification, otpToken, otp } = req.body;

      if (!name || !department || !contact || !email || !joiningDate) {
        return res.status(400).json({
          error: 'Please provide all required fields: Name, Department, Contact, Email, and Date of Joining.',
        });
      }

      if (!DEPARTMENTS.includes(department)) {
        return res.status(400).json({
          error: `Invalid department. Allowed options: ${DEPARTMENTS.join(', ')}`,
        });
      }

      const cleanEmail = email.trim().toLowerCase();

      // Verify email ownership via OTP Token or OTP code
      let isEmailVerified = false;
      if (otpToken) {
        try {
          const decoded = jwt.verify(otpToken, process.env.JWT_SECRET || 'iuhp-jwt-secret-key-2026');
          if (decoded.email === cleanEmail && decoded.verified) {
            isEmailVerified = true;
          }
        } catch {}
      }

      if (!isEmailVerified && otp) {
        const record = await Otp.findOne({ email: cleanEmail, otp: otp.trim() });
        if (record) {
          isEmailVerified = true;
          await Otp.deleteMany({ email: cleanEmail });
        }
      }

      if (!isEmailVerified) {
        return res.status(403).json({
          error: '🔒 Please verify your official email address with OTP before saving your faculty profile.',
        });
      }

      let existingEmp = await Employee.findOne({ email: cleanEmail });

      let photoUrl = existingEmp?.photoUrl || '';
      let resumeUrl = (existingEmp?.resumeUrl && existingEmp.resumeUrl !== SAMPLE_RESUME) ? existingEmp.resumeUrl : '';

      const photo = req.files?.photo?.[0];
      const resume = req.files?.resume?.[0];

      // Standard 3:4 passport-style photo, face-centered uploaded to Cloudinary
      if (photo) {
        try {
          const uploadResult = await toCloud(photo.buffer, {
            folder: 'employee-portal/photos',
            transformation: [{ width: 300, height: 400, crop: 'fill', gravity: 'face' }],
          });
          photoUrl = uploadResult.secure_url;
        } catch (photoErr) {
          console.error('Photo upload warning:', photoErr.message);
          return res.status(500).json({ error: 'Failed to upload photograph: ' + photoErr.message });
        }
      }

      // Upload new resume PDF directly to Cloudinary (raw asset)
      let newResumeCloudUrl = '';
      if (resume) {
        try {
          newResumeCloudUrl = await uploadResumeToCloudinary(resume.buffer, name);
        } catch (resumeErr) {
          console.error('Resume upload error:', resumeErr.message);
          return res.status(500).json({ error: 'Failed to upload resume to Cloudinary: ' + resumeErr.message });
        }
      }

      if (existingEmp) {
        const hasExistingPhoto = Boolean(existingEmp.photoUrl);
        const hasExistingResume = Boolean(existingEmp.resumeUrl || existingEmp.resumeData?.data);

        // Validate that photo exists or is uploaded
        if (!hasExistingPhoto && !photo) {
          return res.status(400).json({ error: 'Passport photograph is required. Please upload your photo.' });
        }

        // Validate that resume exists or is uploaded
        if (!hasExistingResume && !resume) {
          return res.status(400).json({ error: 'Resume (PDF) is required. Please upload your Resume PDF.' });
        }

        // Delete old Cloudinary photo if replaced
        if (photo && existingEmp.photoUrl && existingEmp.photoUrl !== photoUrl) {
          deleteFromCloudinary(existingEmp.photoUrl);
        }

        // Delete old Cloudinary resume if replaced
        if (resume && existingEmp.resumeUrl && existingEmp.resumeUrl.includes('cloudinary.com')) {
          deleteFromCloudinary(existingEmp.resumeUrl);
        }

        // Update existing faculty member
        existingEmp.name = name.trim();
        existingEmp.department = department;
        existingEmp.contact = contact.trim();
        existingEmp.joiningDate = new Date(joiningDate);
        if (designation) existingEmp.designation = designation.trim();
        if (highestQualification) existingEmp.highestQualification = highestQualification.trim();
        if (photoUrl) existingEmp.photoUrl = photoUrl;

        // If a new resume is uploaded, use Cloudinary URL and clear old binary buffer
        if (newResumeCloudUrl) {
          existingEmp.resumeUrl = newResumeCloudUrl;
          existingEmp.resumeData = undefined; // No longer store binary buffer in MongoDB
        } else if (resumeUrl) {
          existingEmp.resumeUrl = resumeUrl;
        }

        await existingEmp.save();

        return res.json({
          ok: true,
          message: 'Your faculty profile was updated successfully!',
          employee: {
            _id: existingEmp._id,
            name: existingEmp.name,
            department: existingEmp.department,
            designation: existingEmp.designation,
            highestQualification: existingEmp.highestQualification,
            contact: existingEmp.contact,
            email: existingEmp.email,
            joiningDate: existingEmp.joiningDate,
            photoUrl: existingEmp.photoUrl,
            resumeUrl: existingEmp.resumeUrl || (existingEmp.resumeData?.data ? `/api/public/employees/${existingEmp._id}/resume.pdf` : ''),
          },
          isUpdate: true,
        });
      } else {
        // Create new faculty member - require photo and resume
        if (!photo) {
          return res.status(400).json({
            error: 'Passport photograph is required. Please upload your standard 3:4 portrait photo.',
          });
        }

        if (!resume) {
          return res.status(400).json({
            error: 'Curriculum Vitae / Resume (PDF) is required. Please upload your official PDF document.',
          });
        }

        const newEmp = new Employee({
          name: name.trim(),
          department,
          contact: contact.trim(),
          email: cleanEmail,
          joiningDate: new Date(joiningDate),
          designation: designation ? designation.trim() : 'Faculty Member',
          highestQualification: highestQualification ? highestQualification.trim() : 'Post-Graduate',
          photoUrl,
          resumeUrl: newResumeCloudUrl,
        });

        await newEmp.save();

        return res.status(201).json({
          ok: true,
          message: 'Your faculty profile has been registered successfully!',
          employee: {
            _id: newEmp._id,
            name: newEmp.name,
            department: newEmp.department,
            designation: newEmp.designation,
            highestQualification: newEmp.highestQualification,
            contact: newEmp.contact,
            email: newEmp.email,
            joiningDate: newEmp.joiningDate,
            photoUrl: newEmp.photoUrl,
            resumeUrl: newEmp.resumeUrl,
          },
          isUpdate: false,
        });
      }
    } catch (err) {
      console.error('Faculty self-registration error:', err);
      res.status(400).json({ error: err.message || 'Failed to submit faculty profile' });
    }
  }
);

// ---------- Admin Management Endpoints ----------
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const total = await Employee.countDocuments();
    const byDept = {};
    for (const d of DEPARTMENTS) {
      byDept[d] = await Employee.countDocuments({ department: d });
    }
    res.json({ total, byDept, departments: DEPARTMENTS, departmentDetails: DEPARTMENT_DETAILS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/employees', requireAdmin, async (req, res) => {
  try {
    const { department, q } = req.query;
    const filter = {};
    if (department && DEPARTMENTS.includes(department)) {
      filter.department = department;
    }
    if (q) {
      const regex = new RegExp(q.trim(), 'i');
      filter.$or = [{ name: regex }, { email: regex }, { contact: regex }, { designation: regex }];
    }
    const employees = await Employee.find(filter)
      .select('-resumeData.data')
      .sort({ department: 1, name: 1 })
      .lean();

    const formatted = employees.map((emp) => {
      let resumeUrl = emp.resumeUrl || '';
      if (!resumeUrl && emp.resumeData) {
        resumeUrl = `/api/public/employees/${emp._id}/resume.pdf`;
      }
      return {
        ...emp,
        resumeUrl,
      };
    });

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id).select('-resumeData.data').lean();
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    if (!employee.resumeUrl && employee.resumeData) {
      employee.resumeUrl = `/api/public/employees/${employee._id}/resume.pdf`;
    }
    res.json(employee);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Employee (Photo & Resume uploaded to Cloudinary)
app.post(
  '/api/admin/employees',
  requireAdmin,
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'resume', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { name, department, contact, email, joiningDate, designation, highestQualification } = req.body;
      if (!name || !department || !contact || !email || !joiningDate) {
        return res.status(400).json({ error: 'Please provide Name, Department, Contact, Email, and Date of Joining' });
      }

      if (!DEPARTMENTS.includes(department)) {
        return res.status(400).json({ error: `Invalid department. Allowed: ${DEPARTMENTS.join(', ')}` });
      }

      const photo = req.files?.photo?.[0];
      const resume = req.files?.resume?.[0];

      if (!photo) {
        return res.status(400).json({ error: 'Passport photograph is required. Please select a photo file.' });
      }

      if (!resume) {
        return res.status(400).json({ error: 'Curriculum Vitae / Resume (PDF) is required. Please select a PDF file.' });
      }

      const newEmp = new Employee({
        name: name.trim(),
        department,
        contact: contact.trim(),
        email: email.trim().toLowerCase(),
        joiningDate: new Date(joiningDate),
        designation: designation ? designation.trim() : 'Faculty Member',
        highestQualification: highestQualification ? highestQualification.trim() : 'Post-Graduate',
        photoUrl: '',
        resumeUrl: '',
      });

      // Upload passport-style photo to Cloudinary
      if (photo) {
        try {
          const uploadResult = await toCloud(photo.buffer, {
            folder: 'employee-portal/photos',
            transformation: [{ width: 300, height: 400, crop: 'fill', gravity: 'face' }],
          });
          newEmp.photoUrl = uploadResult.secure_url;
        } catch (pErr) {
          console.error('Admin photo upload error:', pErr.message);
          return res.status(500).json({ error: 'Failed to upload photo to Cloudinary: ' + pErr.message });
        }
      }

      // Upload PDF resume to Cloudinary
      if (resume) {
        try {
          newEmp.resumeUrl = await uploadResumeToCloudinary(resume.buffer, name);
        } catch (rErr) {
          console.error('Admin resume upload error:', rErr.message);
          return res.status(500).json({ error: 'Failed to upload resume to Cloudinary: ' + rErr.message });
        }
      }

      const created = await newEmp.save();
      const returnDoc = created.toObject();
      delete returnDoc.resumeData;
      res.status(201).json(returnDoc);
    } catch (e) {
      console.error('Error creating employee:', e);
      res.status(400).json({ error: e.message || 'Failed to create employee' });
    }
  }
);

// Edit Employee
app.put(
  '/api/admin/employees/:id',
  requireAdmin,
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'resume', maxCount: 1 }]),
  async (req, res) => {
    try {
      const employee = await Employee.findById(req.params.id);
      if (!employee) return res.status(404).json({ error: 'Employee not found' });

      const { name, department, contact, email, joiningDate, designation, highestQualification } = req.body;
      if (name) employee.name = name.trim();
      if (department && DEPARTMENTS.includes(department)) employee.department = department;
      if (contact) employee.contact = contact.trim();
      if (email) employee.email = email.trim().toLowerCase();
      if (joiningDate) employee.joiningDate = new Date(joiningDate);
      if (designation) employee.designation = designation.trim();
      if (highestQualification) employee.highestQualification = highestQualification.trim();

      const photo = req.files?.photo?.[0];
      const resume = req.files?.resume?.[0];

      if (photo) {
        try {
          const uploadResult = await toCloud(photo.buffer, {
            folder: 'employee-portal/photos',
            transformation: [{ width: 300, height: 400, crop: 'fill', gravity: 'face' }],
          });
          // Delete old Cloudinary photo if replaced
          if (employee.photoUrl && employee.photoUrl !== uploadResult.secure_url) {
            deleteFromCloudinary(employee.photoUrl);
          }
          employee.photoUrl = uploadResult.secure_url;
        } catch (pErr) {
          console.error('Admin edit photo upload error:', pErr.message);
          return res.status(500).json({ error: 'Failed to upload photo to Cloudinary: ' + pErr.message });
        }
      }

      if (resume) {
        try {
          // Delete old Cloudinary resume if replaced
          if (employee.resumeUrl && employee.resumeUrl.includes('cloudinary.com')) {
            deleteFromCloudinary(employee.resumeUrl);
          }
          employee.resumeUrl = await uploadResumeToCloudinary(resume.buffer, employee.name);
          employee.resumeData = undefined; // Clear old MongoDB binary buffer
        } catch (rErr) {
          console.error('Admin edit resume upload error:', rErr.message);
          return res.status(500).json({ error: 'Failed to upload resume to Cloudinary: ' + rErr.message });
        }
      }

      await employee.save();
      const returnDoc = employee.toObject();
      delete returnDoc.resumeData;
      delete returnDoc.pin;
      res.json(returnDoc);
    } catch (e) {
      console.error('Error updating employee:', e);
      res.status(400).json({ error: e.message || 'Failed to update employee' });
    }
  }
);

// Delete Employee
app.delete('/api/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await Employee.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Employee not found' });

    // Clean up Cloudinary photo & resume
    if (deleted.photoUrl) {
      deleteFromCloudinary(deleted.photoUrl);
    }
    if (deleted.resumeUrl && deleted.resumeUrl.includes('cloudinary.com')) {
      deleteFromCloudinary(deleted.resumeUrl);
    }

    res.json({ ok: true, deletedId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper function to send alert / message email to a single employee
async function sendAlertEmailToEmployee(employee, alertType, customMessage, baseUrl) {
  const type = alertType || 'both';
  let subject = 'Action Required: Please update your IUHP Faculty Profile details';
  let title = 'Faculty Profile Revision Required';
  let mainMessage = '';
  let guidelinesHtml = '';
  let isSuccess = false;

  const templatePdfUrl = 'https://www.iuraipur.edu.in/FacultyImages/BMMrRk0yTwAmYW7ALh2azX6dRSN4HKvGFvzaGPVNrg47UO6pQZSnEExe0dATi8.pdf';
  let actionUrl = `${baseUrl}/register?email=${encodeURIComponent(employee.email)}`;
  let actionBtnText = '✏️ Click Here to Update Your Profile & Resume';

  if (type === 'thankyou' || type === 'approved' || type === 'success' || type === 'message') {
    isSuccess = true;
    subject = `Official Notice: Faculty Profile Verified & Active - ${employee.name} (IUHP)`;
    title = '📋 Faculty Profile Verified & Officially Active';
    mainMessage = 'We are pleased to inform you that your faculty profile, passport photograph, and academic curriculum vitae have been reviewed, verified, and officially published in the University Faculty Directory.';
    guidelinesHtml = `
      • <strong>Directory Status:</strong> Active & Publicly Verified<br>
      • <strong>Department:</strong> ${employee.department}<br>
      • <strong>Designation:</strong> ${employee.designation || 'Faculty Member'}<br>
      • <strong>Assets:</strong> Passport photograph (3:4 standard) and academic CV are verified and active on Cloudinary.
    `;
    actionUrl = `${baseUrl}/#section-${employee.department}`;
    actionBtnText = '🌐 View Your Profile in Public Directory';
  } else if (type === 'welcome') {
    isSuccess = true;
    subject = `Welcome to ICFAI University Himachal Pradesh: Faculty Profile Verified`;
    title = '🎓 Welcome to IUHP Faculty Directory';
    mainMessage = 'Welcome to The ICFAI University, Himachal Pradesh! Your faculty onboarding profile has been approved and added to the official institutional directory.';
    guidelinesHtml = `
      • <strong>Faculty Name:</strong> ${employee.name}<br>
      • <strong>Department:</strong> ${employee.department}<br>
      • <strong>Designation:</strong> ${employee.designation || 'Faculty Member'}<br>
      • <strong>Official Email:</strong> ${employee.email}
    `;
    actionUrl = `${baseUrl}/#section-${employee.department}`;
    actionBtnText = '🌐 Explore University Faculty Directory';
  } else if (type === 'photo') {
    subject = 'Action Required: Update Passport Photograph - IUHP Faculty Portal';
    title = '📸 Passport Photograph Format Revision Required';
    mainMessage = 'Your uploaded profile photograph does not match the university official standard. Please upload a formal passport-sized portrait photograph (3:4 aspect ratio, plain/neutral background, frontal face view).';
    guidelinesHtml = `
      • <strong>Format:</strong> JPG or PNG (Maximum 10MB)<br>
      • <strong>Ratio:</strong> 3:4 Portrait standard<br>
      • <strong>Appearance:</strong> Formal university attire, neutral background, centered face. Avoid casual selfies or group pictures.
    `;
  } else if (type === 'resume') {
    subject = 'Action Required: Update Academic CV according to Official Template - IUHP Faculty Portal';
    title = '📄 Academic CV / Resume Format Revision Required';
    mainMessage = `Your uploaded Curriculum Vitae / Resume must strictly follow the official university reference template. Please review the provided example template and revise your CV document accordingly.`;
    guidelinesHtml = `
      • <strong>Official Reference Template:</strong> <a href="${templatePdfUrl}" target="_blank" style="color:#0f4c5c;font-weight:700;text-decoration:underline;">Click Here to View Official Example CV Template (PDF) ↗</a><br>
      • <strong>Format:</strong> PDF document (Maximum 10MB)<br>
      • <strong>Mandatory Sections:</strong> Contact Details, Educational Qualifications (Ph.D./PG/UG with passing year & university), Teaching & Research Experience, Publications, Books, Patents, FDPs & Memberships as shown in the example template.
    `;
  } else {
    // type === 'both'
    subject = 'Action Required: Update Photograph & Resume (Official Template) - IUHP Faculty Portal';
    title = '🔄 Profile Photograph & Resume Format Revisions Required';
    mainMessage = `Both your profile photograph and curriculum vitae (resume) require revisions to align with the official standards of The ICFAI University, Himachal Pradesh. Your resume must follow the university's official reference template.`;
    guidelinesHtml = `
      • <strong>1. Photograph:</strong> Formal 3:4 portrait passport-sized photo (formal attire, neutral background, centered face).<br>
      • <strong>2. Resume:</strong> Must follow the <a href="${templatePdfUrl}" target="_blank" style="color:#0f4c5c;font-weight:700;text-decoration:underline;">Official Example CV Template (PDF) ↗</a> in PDF format detailing academic degrees, experience, and publications.
    `;
  }

  const badgeHtml = isSuccess
    ? `<div style="display:inline-block; background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; border-radius:6px; padding:4px 12px; font-size:12px; font-weight:700; margin-bottom:14px;">✨ PROFILE VERIFIED & APPROVED</div>`
    : `<div style="display:inline-block; background:#fef3c7; color:#92400e; border:1px solid #fde68a; border-radius:6px; padding:4px 12px; font-size:12px; font-weight:700; margin-bottom:14px;">⚠️ ACTION REQUIRED: PROFILE REVISION</div>`;

  const borderColor = isSuccess ? '#10b981' : '#e09f3e';
  const btnBg = isSuccess ? '#059669' : '#0f4c5c';

  const mailOptions = {
    from: `"IUHP Administration" <${process.env.EMAIL_USER || 'yogender@iuhimachal.edu.in'}>`,
    to: employee.email,
    subject,
    html: `
      <div style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width:600px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,0.06);">
        <div style="background:linear-gradient(135deg, #0f4c5c 0%, #1e293b 100%); padding:24px 20px; text-align:center; color:#ffffff;">
          <h2 style="margin:0; font-size:20px; font-weight:700; letter-spacing:0.5px;">THE ICFAI UNIVERSITY</h2>
          <div style="font-size:12px; color:#e09f3e; font-weight:700; margin-top:4px; letter-spacing:1px;">HIMACHAL PRADESH • FACULTY PORTAL</div>
        </div>
        <div style="padding:32px 24px; color:#334155;">
          ${badgeHtml}
          <h3 style="margin:0 0 12px; font-size:18px; color:#0f172a; font-weight:700;">Dear ${employee.name},</h3>
          <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:#475569;">
            ${isSuccess
              ? 'We have an administrative update regarding your profile status in the official University Faculty Directory:'
              : 'During the administrative review of faculty records in the University Directory, the following items in your profile were flagged for revision:'
            }
          </p>

          <div style="background:#f8fafc; border-left:4px solid ${borderColor}; border-radius:4px; padding:16px; margin:16px 0;">
            <div style="font-weight:700; color:#0f4c5c; font-size:15px; margin-bottom:6px;">${title}</div>
            <div style="font-size:13.5px; line-height:1.5; color:#334155;">${mainMessage}</div>
            ${customMessage && customMessage.trim() ? `
              <div style="margin-top:12px; padding-top:10px; border-top:1px dashed #cbd5e1; font-size:13px; color:#1e293b;">
                <strong>Admin Remarks / Note:</strong> ${customMessage.trim()}
              </div>
            ` : ''}
          </div>

          <div style="background:#f1f5f9; border-radius:8px; padding:16px; margin:20px 0; font-size:13px; color:#475569; line-height:1.6;">
            <strong style="color:#0f172a; display:block; margin-bottom:6px;">${isSuccess ? '📋 Verification Summary:' : '📋 Official Format Guidelines:'}</strong>
            ${guidelinesHtml}
          </div>

          <div style="text-align:center; margin:28px 0 16px;">
            <a href="${actionUrl}" style="background:${btnBg}; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:6px; font-weight:700; font-size:14px; display:inline-block; box-shadow:0 2px 6px rgba(15,76,92,0.3);">
              ${actionBtnText}
            </a>
          </div>
          <p style="font-size:12px; color:#94a3b8; text-align:center; margin-top:16px;">
            Direct link: <a href="${actionUrl}" style="color:#0f4c5c; word-break:break-all;">${actionUrl}</a>
          </p>
        </div>
        <div style="background:#f1f5f9; padding:14px 24px; text-align:center; font-size:12px; color:#94a3b8; border-top:1px solid #e2e8f0;">
          © 2026 The ICFAI University, Himachal Pradesh. All rights reserved.
        </div>
      </div>
    `,
  };

  const mailTransporter = getMailTransporter();
  await mailTransporter.sendMail(mailOptions);

  employee.lastAlert = {
    alertType: type,
    sentAt: new Date(),
    message: (customMessage || mainMessage).slice(0, 300),
  };
  await employee.save();
  return { ok: true, isSuccess };
}

// Send Quality Alert Email to a Single Faculty Member
app.post('/api/admin/employees/:id/alert', requireAdmin, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const { alertType, customMessage } = req.body || {};
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    const { isSuccess } = await sendAlertEmailToEmployee(employee, alertType, customMessage, baseUrl);

    res.json({
      ok: true,
      message: isSuccess
        ? `Official message notice sent successfully to ${employee.email}!`
        : `Revision alert email sent successfully to ${employee.email}!`,
    });
  } catch (err) {
    console.error('Failed to send faculty alert:', err);
    res.status(500).json({ error: 'Failed to send alert email: ' + (err.message || 'Check email configuration') });
  }
});

// Bulk Send Quality Alert / Message Email to Multiple Faculty Members
app.post('/api/admin/employees/bulk-alert', requireAdmin, async (req, res) => {
  try {
    const { ids, alertType, customMessage } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No employee IDs selected' });
    }

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    const employees = await Employee.find({ _id: { $in: ids } });
    let sentCount = 0;
    const errors = [];

    for (const emp of employees) {
      try {
        await sendAlertEmailToEmployee(emp, alertType, customMessage, baseUrl);
        sentCount++;
      } catch (e) {
        console.error(`Failed to send alert to ${emp.email}:`, e.message);
        errors.push({ id: emp._id, email: emp.email, error: e.message });
      }
    }

    res.json({
      ok: true,
      total: ids.length,
      sentCount,
      failedCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Successfully dispatched email notification to ${sentCount} of ${ids.length} faculty member(s)!`,
    });
  } catch (err) {
    console.error('Bulk alert error:', err);
    res.status(500).json({ error: 'Failed to process bulk alert: ' + err.message });
  }
});

// Bulk Delete Multiple Faculty Members
app.post('/api/admin/employees/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No employee IDs selected for deletion' });
    }

    const employees = await Employee.find({ _id: { $in: ids } });
    for (const emp of employees) {
      if (emp.photoUrl) await deleteFromCloudinary(emp.photoUrl);
      if (emp.resumeUrl) await deleteFromCloudinary(emp.resumeUrl);
    }

    const result = await Employee.deleteMany({ _id: { $in: ids } });
    res.json({
      ok: true,
      deletedCount: result.deletedCount,
      message: `Successfully removed ${result.deletedCount} employee record(s).`,
    });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ error: 'Failed to process bulk delete: ' + err.message });
  }
});

// ---------- Google Sheets & Excel Export (.xlsx) ----------
// Includes Name, Contact, Email, Date of Joining, Photograph (standard cell size with =IMAGE formula), Resume (=HYPERLINK)
app.get('/api/admin/export.xlsx', requireAdmin, async (req, res) => {
  try {
    const q = req.query.department ? { department: req.query.department } : {};
    const employees = await Employee.find(q).sort({ department: 1, name: 1 }).lean();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'IUHP Employee Portal';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Employee Directory', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { defaultRowHeight: 115 }, // Standard ~150px height for photo rows
    });

    // Column definitions with standard sizes (Photograph column width ~22 gives ~120px)
    sheet.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Department', key: 'department', width: 16 },
      { header: 'Designation', key: 'designation', width: 22 },
      { header: 'Highest Qualification', key: 'highestQualification', width: 25 },
      { header: 'Contact', key: 'contact', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Date of Joining', key: 'joiningDate', width: 18 },
      { header: 'Photograph', key: 'photo', width: 22 }, // ~120px standard width
      { header: 'Resume', key: 'resume', width: 28 },
    ];

    // Style the header row
    const headerRow = sheet.getRow(1);
    headerRow.height = 32;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0F4C5C' }, // Brand navy
      };
      cell.font = {
        name: 'Segoe UI',
        bold: true,
        color: { argb: 'FFFFFFFF' },
        size: 11,
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        bottom: { style: 'medium', color: { argb: 'FFE09F3E' } },
      };
    });

    // Populate data rows
    employees.forEach((emp, index) => {
      const rowNum = index + 2;
      const row = sheet.getRow(rowNum);
      row.height = 115; // Passport-style 150px cell height

      const dateStr = emp.joiningDate ? new Date(emp.joiningDate).toISOString().slice(0, 10) : '';

      // Photograph in cell: uses Google Sheets / Excel =IMAGE(url, 1) formula for direct cell image rendering!
      const photoCellVal = emp.photoUrl
        ? { formula: `IMAGE("${emp.photoUrl}", 1)` }
        : 'No Photo';

      let effectiveResumeUrl = emp.resumeUrl || '';
      if (!effectiveResumeUrl && emp.resumeData) {
        effectiveResumeUrl = `/api/public/employees/${emp._id}/resume.pdf`;
      }

      const resumeCellVal = effectiveResumeUrl
        ? { formula: `HYPERLINK("${effectiveResumeUrl}", "📄 View Resume")` }
        : '—';

      row.values = [
        emp.name,
        emp.department,
        emp.designation || 'Faculty Member',
        emp.highestQualification || 'Post-Graduate',
        emp.contact,
        emp.email,
        dateStr,
        photoCellVal,
        resumeCellVal,
      ];

      // Align cells
      row.eachCell((cell, colNumber) => {
        cell.alignment = {
          vertical: 'middle',
          horizontal: colNumber === 1 || colNumber === 3 || colNumber === 4 || colNumber === 6 ? 'left' : 'center',
          wrapText: true,
        };
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.border = {
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        };
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="IUHP_Employee_Directory_${Date.now()}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ---------- CSV Export ----------
app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
  try {
    const q = req.query.department ? { department: req.query.department } : {};
    const rows = await Employee.find(q).sort({ department: 1, name: 1 }).lean();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Name', 'Department', 'Designation', 'Highest Qualification', 'Contact', 'Email', 'Date of Joining', 'Photograph', 'Resume'];
    const lines = rows.map((r) => {
      let effectiveResumeUrl = r.resumeUrl || '';
      if (!effectiveResumeUrl && r.resumeData) {
        effectiveResumeUrl = `/api/public/employees/${r._id}/resume.pdf`;
      }
      return [
        r.name,
        r.department,
        r.designation || 'Faculty Member',
        r.highestQualification || 'Post-Graduate',
        r.contact,
        r.email,
        r.joiningDate?.toISOString().slice(0, 10),
        r.photoUrl,
        effectiveResumeUrl,
      ].map(esc).join(',');
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
    res.send('\ufeff' + [head.map(esc).join(','), ...lines].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Google Sheets Compatible Template (.xlsx) ----------
// 100 blank rows, pre-sized 120px passport photo column, row height 150px, frozen header & filters
app.get('/api/admin/template.xlsx', (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'IUHP Employee Portal';

    const sheet = workbook.addWorksheet('Employee Directory', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { defaultRowHeight: 115 },
    });

    sheet.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Department', key: 'department', width: 16 },
      { header: 'Designation', key: 'designation', width: 22 },
      { header: 'Highest Qualification', key: 'highestQualification', width: 25 },
      { header: 'Contact', key: 'contact', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Date of Joining', key: 'joiningDate', width: 18 },
      { header: 'Photograph', key: 'photo', width: 22 }, // ~120px width
      { header: 'Resume', key: 'resume', width: 28 },
    ];

    const header = sheet.getRow(1);
    header.height = 32;
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C5C' } };
      cell.font = { name: 'Segoe UI', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Sample row
    const sampleRow = sheet.getRow(2);
    sampleRow.height = 115;
    sampleRow.values = [
      'Dr. Rahul Sharma (Sample)',
      'FST',
      'Professor & HOD',
      'Ph.D. in Computer Science',
      '9876543210',
      'rahul.sharma@iuhp.edu.in',
      '2026-10-01',
      { formula: `IMAGE("https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&h=533&q=80", 1)` },
      { formula: `HYPERLINK("${SAMPLE_RESUME}", "📄 View Resume")` },
    ];
    sampleRow.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.font = { name: 'Segoe UI', size: 10, italic: true };
    });

    // 100 blank rows ready with fixed 115pt height
    for (let r = 3; r <= 102; r++) {
      const row = sheet.getRow(r);
      row.height = 115;
      row.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    }

    // Add Instructions sheet
    const guideSheet = workbook.addWorksheet('Instructions');
    guideSheet.columns = [{ header: 'Guide to Using this Template with Google Sheets', width: 80 }];
    guideSheet.addRow(['1. Upload this .xlsx file directly to Google Drive and open with Google Sheets.']);
    guideSheet.addRow(['2. For Photograph: Paste direct image link in =IMAGE("URL", 1) or click Insert > Image > Insert image in cell.']);
    guideSheet.addRow(['3. Passport Photo sizing: Column width is preset to ~120px, Row height to ~150px (115pt), 3:4 portrait ratio.']);
    guideSheet.addRow(['4. For Resume: Paste PDF link or use =HYPERLINK("PDF_URL", "Resume").']);
    guideSheet.addRow(['5. Department codes: FPS, FMS, FLA, FOL, FST.']);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Employee_Directory_Template.xlsx"');

    workbook.xlsx.write(res).then(() => res.end());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Explicit page routes
app.get(['/register', '/join'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'register.html'));
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'admin.html'));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'index.html'));
  });
});

// ---------- Database Seed & Server Start ----------
const SEED_DATA = [
  // FPS - Faculty of Pharmaceutical Sciences
  {
    name: 'Dr. Rajesh Kumar Sharma',
    department: 'FPS',
    designation: 'Professor & Dean',
    highestQualification: 'Ph.D. in Pharmaceutical Sciences',
    contact: '+91 98765 12340',
    email: 'rajesh.sharma@iuhp.edu.in',
    joiningDate: new Date('2021-07-15'),
    photoUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  {
    name: 'Dr. Meera Nair',
    department: 'FPS',
    designation: 'Associate Professor, Pharmacology',
    highestQualification: 'Ph.D., M.Pharm (Gold Medalist)',
    contact: '+91 98765 12341',
    email: 'meera.nair@iuhp.edu.in',
    joiningDate: new Date('2022-03-10'),
    photoUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  // FMS - Faculty of Management Studies
  {
    name: 'Prof. Amitav Ghosh',
    department: 'FMS',
    designation: 'Director, School of Management',
    highestQualification: 'Ph.D. in Business Administration, MBA',
    contact: '+91 98765 22340',
    email: 'amitav.ghosh@iuhp.edu.in',
    joiningDate: new Date('2020-01-20'),
    photoUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  {
    name: 'Dr. Priya Patel',
    department: 'FMS',
    designation: 'Assistant Professor, Marketing',
    highestQualification: 'Ph.D., MBA (Marketing)',
    contact: '+91 98765 22341',
    email: 'priya.patel@iuhp.edu.in',
    joiningDate: new Date('2023-08-01'),
    photoUrl: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  // FLA - Faculty of Liberal Arts
  {
    name: 'Prof. Sunita Rao',
    department: 'FLA',
    designation: 'Head of Department, English Literature',
    highestQualification: 'Ph.D. in English Literature',
    contact: '+91 98765 32340',
    email: 'sunita.rao@iuhp.edu.in',
    joiningDate: new Date('2019-11-05'),
    photoUrl: 'https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  {
    name: 'Dr. Vikramaditya Verma',
    department: 'FLA',
    designation: 'Associate Professor, History',
    highestQualification: 'Ph.D. in Ancient History & Archaeology',
    contact: '+91 98765 32341',
    email: 'vikram.verma@iuhp.edu.in',
    joiningDate: new Date('2022-09-15'),
    photoUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  // FOL - Faculty of Law
  {
    name: 'Adv. Rohit Deshmukh',
    department: 'FOL',
    designation: 'Dean, Faculty of Law',
    highestQualification: 'LL.M., Ph.D. in Constitutional Law',
    contact: '+91 98765 42340',
    email: 'rohit.deshmukh@iuhp.edu.in',
    joiningDate: new Date('2018-06-12'),
    photoUrl: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  {
    name: 'Prof. Ananya Sengupta',
    department: 'FOL',
    designation: 'Assistant Professor, Constitutional Law',
    highestQualification: 'LL.M. in Corporate & Commercial Law',
    contact: '+91 98765 42341',
    email: 'ananya.sengupta@iuhp.edu.in',
    joiningDate: new Date('2024-01-10'),
    photoUrl: 'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  // FST - Faculty of Science & Technology
  {
    name: 'Dr. Yogender Singh',
    department: 'FST',
    designation: 'Professor & Head, Computer Science',
    highestQualification: 'Ph.D. in Computer Science & Engineering',
    contact: '+91 98765 52340',
    email: 'yogender.singh@iuhp.edu.in',
    joiningDate: new Date('2020-04-01'),
    photoUrl: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
  {
    name: 'Prof. Kavita Menon',
    department: 'FST',
    designation: 'Associate Professor, Artificial Intelligence',
    highestQualification: 'M.Tech, Ph.D. in Artificial Intelligence',
    contact: '+91 98765 52341',
    email: 'kavita.menon@iuhp.edu.in',
    joiningDate: new Date('2023-02-14'),
    photoUrl: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=400&h=533&q=80',
    resumeUrl: SAMPLE_RESUME,
  },
];

const PORT = process.env.PORT || 3000;

// Cached DB connection for serverless / Vercel
let isConnected = false;
async function connectDB() {
  if (isConnected || mongoose.connection.readyState >= 1) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
}

// Start local listener if not running as a Vercel serverless function
if (!process.env.VERCEL) {
  connectDB()
    .then(async () => {
      console.log('Connected to MongoDB Atlas successfully.');
      const count = await Employee.countDocuments();
      if (count === 0) {
        await Employee.insertMany(SEED_DATA);
        console.log(`Seeded ${SEED_DATA.length} initial faculty members across all 5 departments.`);
      }
      app.listen(PORT, () => {
        console.log(`IUHP Portal running on http://localhost:${PORT}`);
      });
    })
    .catch((e) => {
      console.error('MongoDB Atlas connection failed:', e.message);
      process.exit(1);
    });
}

module.exports = app;
