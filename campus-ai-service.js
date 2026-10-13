/**
 * NJ.AI Service - The ICFAI University, Himachal Pradesh (IUHP)
 * Powered by Local On-Premise & Tunnel Model Engine
 * Name: NJ.AI (IUHP Institutional Intelligence Copilot)
 * Features: Live RAG, Multi-action execution, Document Letterhead Studio, Slash Commands, Fallback Engine.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const PRIMARY_MODEL_URL = (process.env.AI_MODEL_URL || 'https://month-allocated-contributions-iowa.trycloudflare.com').replace(/\/+$/, '');
const FALLBACK_MODEL_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL_NAME = process.env.AI_MODEL_NAME || 'qwen2.5:1.5b';

const DEPARTMENTS = {
  FPS: { name: 'Faculty of Pharmaceutical Sciences', short: 'FPS', icon: '💊', color: '#d97706', bg: '#fef3c7' },
  FMS: { name: 'Faculty of Management Studies', short: 'FMS', icon: '📊', color: '#059669', bg: '#d1fae5' },
  FLA: { name: 'Faculty of Liberal Arts', short: 'FLA', icon: '🎨', color: '#7c3aed', bg: '#ede9fe' },
  FOL: { name: 'Faculty of Law', short: 'FOL', icon: '⚖️', color: '#dc2626', bg: '#fee2e2' },
  FST: { name: 'Faculty of Science & Technology', short: 'FST', icon: '💻', color: '#0284c7', bg: '#e0f2fe' },
};

function calcTenure(joiningDate) {
  if (!joiningDate) return '—';
  const join = new Date(joiningDate);
  if (isNaN(join.getTime())) return '—';
  const now = new Date();
  const diffMs = now.getTime() - join.getTime();
  if (diffMs <= 0) return '0.1 Year';
  const diffYears = diffMs / (1000 * 60 * 60 * 24 * 365.25);
  const rounded = Math.max(0.1, parseFloat(diffYears.toFixed(1)));
  return rounded === 1.0 ? '1.0 Year' : `${rounded.toFixed(1)} Years`;
}

function sanitizeEmployee(emp) {
  if (!emp) return null;
  const doc = emp.toObject ? emp.toObject() : { ...emp };
  delete doc.resumeData;
  delete doc.__v;
  doc.tenure = calcTenure(doc.joiningDate);
  doc.deptInfo = DEPARTMENTS[doc.department] || null;
  return doc;
}

class CampusAIService {
  constructor(models) {
    this.Employee = models.Employee;
    this.RegistrationRequest = models.RegistrationRequest;
    this.activeEndpoint = PRIMARY_MODEL_URL;
    this.activeModel = DEFAULT_MODEL_NAME;
  }

  // Probe single endpoint
  async probeEndpoint(targetUrl, timeoutMs = 4000) {
    const startTime = Date.now();
    return new Promise((resolve) => {
      try {
        const parsed = new URL(`${targetUrl}/v1/models`);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(parsed, { method: 'GET', timeout: timeoutMs, family: 4 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latencyMs = Date.now() - startTime;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsedData = JSON.parse(data);
                const models = (parsedData.data || []).map(m => m.id);
                resolve({ online: true, latencyMs, endpoint: targetUrl, models });
              } catch (_) {
                resolve({ online: true, latencyMs, endpoint: targetUrl, models: [DEFAULT_MODEL_NAME] });
              }
            } else {
              resolve({ online: false, error: `HTTP ${res.statusCode}`, latencyMs, endpoint: targetUrl });
            }
          });
        });
        req.on('timeout', () => { req.destroy(); resolve({ online: false, error: 'Timed out', endpoint: targetUrl }); });
        req.on('error', (err) => resolve({ online: false, error: err.message, endpoint: targetUrl }));
        req.end();
      } catch (err) {
        resolve({ online: false, error: err.message, endpoint: targetUrl });
      }
    });
  }

  // Health check probing primary and local fallback
  async checkHealth() {
    let result = await this.probeEndpoint(PRIMARY_MODEL_URL, 3500);
    if (result.online) {
      this.activeEndpoint = PRIMARY_MODEL_URL;
      const model = result.models.includes(DEFAULT_MODEL_NAME) ? DEFAULT_MODEL_NAME : (result.models[0] || DEFAULT_MODEL_NAME);
      this.activeModel = model;
      return {
        status: 'online',
        aiName: 'NJ.AI',
        latencyMs: result.latencyMs,
        model: this.activeModel,
        endpoint: 'Cloudflare Tunnel (IUHP Server)',
        availableModels: result.models
      };
    }

    // Try local Ollama fallback
    const localResult = await this.probeEndpoint(FALLBACK_MODEL_URL, 2000);
    if (localResult.online) {
      this.activeEndpoint = FALLBACK_MODEL_URL;
      const model = localResult.models.includes('qwen2.5:1.5b') ? 'qwen2.5:1.5b' : (localResult.models[0] || 'qwen3:8b');
      this.activeModel = model;
      return {
        status: 'online',
        aiName: 'NJ.AI',
        latencyMs: localResult.latencyMs,
        model: this.activeModel,
        endpoint: 'Localhost (Ollama 11434)',
        availableModels: localResult.models
      };
    }

    return {
      status: 'offline',
      aiName: 'NJ.AI',
      error: result.error || 'All AI model endpoints unreachable',
      endpoint: PRIMARY_MODEL_URL
    };
  }

  // Action: Search Faculty by Name, Department, Keyword, or Designation
  async searchFaculty(query = '', dept = '', limit = 8) {
    const filter = {};
    const cleanDept = (dept || '').trim().toUpperCase();
    if (cleanDept && DEPARTMENTS[cleanDept]) {
      filter.department = cleanDept;
    }

    if (query && query.trim()) {
      const q = query.trim();
      const regex = new RegExp(q, 'i');
      filter.$or = [
        { name: regex },
        { designation: regex },
        { highestQualification: regex },
        { email: regex },
        { contact: regex }
      ];
    }

    const employees = await this.Employee.find(filter)
      .select('-resumeData')
      .sort({ joiningDate: 1 })
      .limit(limit)
      .lean();

    return employees.map(sanitizeEmployee);
  }

  // Action: Campus Statistics & Breakdown
  async getCampusStats() {
    const total = await this.Employee.countDocuments();
    const depts = {};
    for (const code of Object.keys(DEPARTMENTS)) {
      const count = await this.Employee.countDocuments({ department: code });
      const regular = await this.Employee.countDocuments({ department: code, employmentType: 'Regular' });
      const visiting = await this.Employee.countDocuments({ department: code, employmentType: 'Visiting' });
      depts[code] = {
        name: DEPARTMENTS[code].name,
        code,
        count,
        regular,
        visiting,
        color: DEPARTMENTS[code].color,
        bg: DEPARTMENTS[code].bg,
        icon: DEPARTMENTS[code].icon
      };
    }

    const regularCount = await this.Employee.countDocuments({ employmentType: 'Regular' });
    const visitingCount = await this.Employee.countDocuments({ employmentType: 'Visiting' });
    const missingPhotos = await this.Employee.countDocuments({ $or: [{ photoUrl: '' }, { photoUrl: null }] });
    const pendingRequests = this.RegistrationRequest ? await this.RegistrationRequest.countDocuments({ status: 'pending' }) : 0;

    return {
      total,
      regularCount,
      visitingCount,
      missingPhotos,
      pendingRequests,
      departments: depts
    };
  }

  // Action: Tenure & Seniority Calculator
  async calculateTenure(joiningDateStr, empId = null) {
    let emp = null;
    let joinDate = null;

    if (empId) {
      emp = await this.Employee.findById(empId).select('-resumeData').lean();
      if (emp) joinDate = new Date(emp.joiningDate);
    } else if (joiningDateStr) {
      joinDate = new Date(joiningDateStr);
    }

    if (!joinDate || isNaN(joinDate.getTime())) {
      return { error: 'Invalid joining date provided' };
    }

    const now = new Date();
    const diffMs = now.getTime() - joinDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffYears = parseFloat((diffDays / 365.25).toFixed(2));
    const roundedTenure = calcTenure(joinDate);

    // Calculate seniority rank university-wide
    const moreSenior = await this.Employee.countDocuments({
      joiningDate: { $lt: joinDate }
    });
    const totalEmp = await this.Employee.countDocuments();
    const rank = moreSenior + 1;

    return {
      joiningDate: joinDate.toISOString().split('T')[0],
      totalDays: diffDays,
      exactYears: diffYears,
      formattedTenure: roundedTenure,
      seniorityRank: rank,
      totalFaculty: totalEmp,
      isMilestone: diffYears >= 5,
      employee: emp ? sanitizeEmployee(emp) : null
    };
  }

  // Action: Official University Document & Letter Drafter
  draftDocument(type, params = {}) {
    const today = new Date().toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const refYear = new Date().getFullYear();
    const refNum = `IUHP/NJ.AI/${refYear}/${Math.floor(1000 + Math.random() * 9000)}`;

    const applicantName = params.name || '[Faculty Name]';
    const designation = params.designation || 'Assistant Professor';
    const dept = params.department || 'FST';
    const deptName = (DEPARTMENTS[dept] && DEPARTMENTS[dept].name) || 'Faculty of Science & Technology';
    const reason = params.reason || 'personal / academic obligations';
    const fromDate = params.fromDate || '[Start Date]';
    const toDate = params.toDate || '[End Date]';
    const days = params.days || '2';

    switch ((type || '').toLowerCase()) {
      case 'casual_leave':
      case 'leave_application':
      case 'leave':
        return {
          type: 'Leave Application',
          refNum,
          date: today,
          title: 'APPLICATION FOR CASUAL / DUTY LEAVE',
          content: `To,
The Registrar / Dean,
${deptName},
The ICFAI University, Himachal Pradesh (IUHP)
Baddi, Distt. Solan, H.P. - 174103

Subject: Application for Leave of Absence from ${fromDate} to ${toDate}

Respected Sir / Madam,

I am writing to formally request leave of absence for ${days} day(s), starting from ${fromDate} to ${toDate}, due to ${reason}.

I have made appropriate arrangements for alternate faculty to oversee my scheduled lectures/labs during this period:
- Alternate Faculty: ${params.alternateFaculty || '[Name of Colleague]'}
- Department / Course: ${dept}

I will resume my regular academic duties on ${params.resumeDate || '[Resumption Date]'}. Kindly approve my leave application.

Thanking you,

Yours sincerely,

${applicantName}
${designation}, ${deptName}
Contact: ${params.contact || '[Phone Number]'}
Official Email: ${params.email || '[Email Address]'}`
        };

      case 'exam_duty':
      case 'invigilation_notice':
      case 'exam':
        return {
          type: 'Examination Circular',
          refNum,
          date: today,
          title: 'OFFICIAL CIRCULAR: END-TERM EXAMINATION INVIGILATION DUTY',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
OFFICE OF THE CONTROLLER OF EXAMINATIONS
Ref: ${refNum}                                              Date: ${today}

CIRCULAR: FACULTY INVIGILATION & EVALUATION DUTIES

All faculty members across FPS, FMS, FLA, FOL, and FST are hereby informed that the upcoming End-Term Examinations schedule has been finalized.

Key Invigilation Directives:
1. Reporting: Invigilators must report to the Exam Control Cell 30 minutes before commencement.
2. Question Paper Integrity: Verify seal integrity and sign collection log with the Center Superintendent.
3. Strict No-Phone Policy: Electronic devices and mobile phones strictly banned inside examination halls.
4. Submission: Hand over answer scripts immediately upon completion with tally sheet.

By Order of Controller of Examinations,
The ICFAI University, Himachal Pradesh`
        };

      case 'noc':
        return {
          type: 'No Objection Certificate',
          refNum,
          date: today,
          title: 'NO OBJECTION CERTIFICATE (NOC)',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
ESTABLISHED UNDER THE ICFAI UNIVERSITY ACT, 2011
Ref: ${refNum}                                              Date: ${today}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that ${applicantName} is employed with The ICFAI University, Himachal Pradesh as ${designation} in the ${deptName} since ${params.joiningDate || '[Joining Date]'}.

The University has NO OBJECTION to ${applicantName} pursuing / attending:
"${params.purpose || 'Higher Academic Studies / National Conference / Research Collaboration'}" during the academic session ${refYear}-${refYear + 1}.

Issued upon employee request for official administrative and academic verification.

Registrar / Authorized Signatory
The ICFAI University, Himachal Pradesh
Campus: Baddi, Solan, H.P.`
        };

      case 'recommendation_letter':
      case 'lor':
        return {
          type: 'Letter of Recommendation',
          refNum,
          date: today,
          title: 'LETTER OF ACADEMIC RECOMMENDATION',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
${deptName}
Ref: ${refNum}                                              Date: ${today}

CONFIDENTIAL LETTER OF RECOMMENDATION

To Whom It May Concern,

It is my distinct privilege to recommend ${params.candidateName || '[Student / Candidate Name]'}, whom I have mentored at The ICFAI University, Himachal Pradesh.

During their academic journey, they demonstrated exceptional diligence, rigorous analytical skills, and exemplary ethical standards. Their academic curiosity and leadership in coursework distinguished them among their peers.

I recommend them for ${params.program || 'their prospective higher education program / professional role'} without reservation.

Warm regards,

${applicantName}
${designation}, ${deptName}
The ICFAI University, Himachal Pradesh`
        };

      case 'minutes':
      case 'meeting_minutes':
        return {
          type: 'Meeting Minutes',
          refNum,
          date: today,
          title: 'MINUTES OF DEPARTMENTAL ACADEMIC COMMITTEE MEETING',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
${deptName}
Ref: ${refNum}                                              Date: ${today}

MINUTES OF MEETING

Chairperson: Dean / Department Head, ${dept}
Attendees: Faculty Members of ${dept}

AGENDA DISCUSSED:
1. Review of current semester curriculum progress and continuous assessment.
2. Lab infrastructure maintenance and student project evaluations.
3. Upcoming guest lecture series and industry interactions.

DECISIONS & ACTION ITEMS:
- [ ] Action Item 1: Complete midterm grading and upload marks to portal by Friday. (Assigned to: All Course Instructors)
- [ ] Action Item 2: Finalize list of external examiners for practical exams. (Assigned to: Department Coordinator)
- [ ] Action Item 3: Submit proposal for AI / Cloud Computing workshop. (Assigned to: FST Event Committee)

Recorded by:
Academic Committee Secretary, ${deptName}`
        };

      case 'syllabus':
      case 'curriculum':
        return {
          type: 'Course Syllabus',
          refNum,
          date: today,
          title: 'COURSE SYLLABUS & 14-WEEK LECTURE PLAN',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
${deptName}

COURSE OUTLINE & LECTURE PLAN
Course Title: ${params.courseName || 'Advanced Machine Learning & Intelligence Systems'}
Course Code: CS-402 | Credits: 4-0-0 (4 Credits)

COURSE OBJECTIVES:
1. Master fundamental principles and theoretical foundations.
2. Formulate practical implementations using industry-standard tools.
3. Analyze real-world engineering and organizational challenges.

14-WEEK MODULAR LECTURE PLAN:
• Week 1-2: Foundations, Mathematical Background, and Core Paradigms
• Week 3-4: Feature Engineering, Model Architecture, and Optimization
• Week 5-6: Supervised & Unsupervised Algorithms, Loss Formulations
• Week 7: Mid-Term Examination & Assessment Review
• Week 8-9: Deep Architectures, Neural Networks, and Embeddings
• Week 10-11: Practical Case Studies, Hyperparameter Tuning, Deployment
• Week 12-13: Emerging Trends, Ethics, Security, and Edge AI
• Week 14: Comprehensive Project Demonstrations & Final Review

RECOMMENDED TEXTBOOKS:
1. Standard Institutional Text, 3rd Edition, Oxford / Cambridge Press.
2. Reference Laboratory Manual, The ICFAI University Press.`
        };

      default:
        return {
          type: 'Official Memorandum',
          refNum,
          date: today,
          title: 'OFFICIAL MEMORANDUM',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
OFFICE OF ACADEMIC AFFAIRS
Ref: ${refNum}                                              Date: ${today}

Subject: ${params.subject || 'Academic Circular / University Notice'}

This is to notify all concerned faculty members and administrative personnel of ${deptName} regarding ${params.subject || 'the scheduled academic agenda'}.

Details:
${params.details || reason}

For any queries, please connect with the Department Coordinator or University Administration.

Registrar,
The ICFAI University, Himachal Pradesh`
        };
    }
  }

  // Action: Check profile status by email or contact
  async checkProfile(identifier) {
    if (!identifier || !identifier.trim()) {
      return { error: 'Please provide an email or phone number to check.' };
    }
    const clean = identifier.trim().toLowerCase();
    const emp = await this.Employee.findOne({
      $or: [{ email: clean }, { contact: clean }]
    }).select('-resumeData').lean();

    if (emp) {
      return {
        found: true,
        type: 'registered_faculty',
        employee: sanitizeEmployee(emp)
      };
    }

    if (this.RegistrationRequest) {
      const req = await this.RegistrationRequest.findOne({
        $or: [{ email: clean }, { contact: clean }]
      }).lean();

      if (req) {
        return {
          found: true,
          type: 'registration_request',
          request: req
        };
      }
    }

    return {
      found: false,
      message: `No faculty record or registration request found for "${identifier}".`
    };
  }

  // Parse user query for actions and perform database extraction for RAG
  async detectAndExecuteAction(userMessage, currentUser = null) {
    const rawMsg = (userMessage || '').trim();
    const msg = rawMsg.toLowerCase();
    let actionResult = null;
    let extraContext = '';

    // Slash command parsing
    if (msg.startsWith('/')) {
      const parts = rawMsg.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      if (cmd === '/faculty' || cmd === '/prof' || cmd === '/search') {
        const results = await this.searchFaculty(arg, '', 6);
        actionResult = { type: 'faculty_cards', count: results.length, query: arg, employees: results };
        extraContext = `\n[SLASH COMMAND /FACULTY RESULTS]:\n${results.map(e => `- ${e.name} (${e.department}) | ${e.designation} | Email: ${e.email}`).join('\n')}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/stats' || cmd === '/analytics') {
        const stats = await this.getCampusStats();
        actionResult = { type: 'campus_stats', stats };
        extraContext = `\n[SLASH COMMAND /STATS]: Total Faculty: ${stats.total}, Regular: ${stats.regularCount}, Visiting: ${stats.visitingCount}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/leave') {
        const draft = this.draftDocument('leave_application', { ...(currentUser || {}), reason: arg || 'personal matters' });
        actionResult = { type: 'document_draft', draft };
        extraContext = `\n[SLASH COMMAND /LEAVE DRAFT GENERATED]:\n${draft.content}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/exam') {
        const draft = this.draftDocument('exam_duty');
        actionResult = { type: 'document_draft', draft };
        extraContext = `\n[SLASH COMMAND /EXAM CIRCULAR GENERATED]:\n${draft.content}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/noc') {
        const draft = this.draftDocument('noc', { purpose: arg || 'Higher Academic Studies' });
        actionResult = { type: 'document_draft', draft };
        extraContext = `\n[SLASH COMMAND /NOC GENERATED]:\n${draft.content}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/lor') {
        const draft = this.draftDocument('recommendation_letter', { candidateName: arg });
        actionResult = { type: 'document_draft', draft };
        extraContext = `\n[SLASH COMMAND /LOR GENERATED]:\n${draft.content}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/minutes') {
        const draft = this.draftDocument('meeting_minutes');
        actionResult = { type: 'document_draft', draft };
        extraContext = `\n[SLASH COMMAND /MINUTES GENERATED]:\n${draft.content}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/syllabus') {
        const draft = this.draftDocument('syllabus', { courseName: arg });
        actionResult = { type: 'document_draft', draft };
        extraContext = `\n[SLASH COMMAND /SYLLABUS GENERATED]:\n${draft.content}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/tenure') {
        const tenureData = await this.calculateTenure(arg || '2021-08-01');
        actionResult = { type: 'tenure_result', data: tenureData };
        extraContext = `\n[SLASH COMMAND /TENURE]: ${tenureData.formattedTenure}, Rank: #${tenureData.seniorityRank}\n`;
        return { actionResult, extraContext };
      }
      if (cmd === '/verify') {
        const profile = await this.checkProfile(arg);
        actionResult = { type: 'profile_check', profile };
        extraContext = `\n[SLASH COMMAND /VERIFY]: Found: ${profile.found}\n`;
        return { actionResult, extraContext };
      }
    }

    // Check for department filter in text
    let targetDept = null;
    for (const code of Object.keys(DEPARTMENTS)) {
      const codeRegex = new RegExp(`\\b${code.toLowerCase()}\\b`, 'i');
      if (codeRegex.test(msg) || msg.includes(DEPARTMENTS[code].name.toLowerCase())) {
        targetDept = code;
        break;
      }
    }

    // 1. Campus Stats
    if (
      msg.includes('stat') ||
      msg.includes('how many faculty') ||
      msg.includes('how many teacher') ||
      msg.includes('department breakdown') ||
      msg.includes('faculty count') ||
      msg.includes('total employee')
    ) {
      const stats = await this.getCampusStats();
      actionResult = { type: 'campus_stats', stats };
      extraContext = `\n[LIVE CAMPUS DATABASE STATS]:\nTotal Faculty: ${stats.total}\nRegular: ${stats.regularCount}, Visiting: ${stats.visitingCount}\nMissing Photos: ${stats.missingPhotos}\nPending Approvals: ${stats.pendingRequests}\nDepartment breakdown:\n${Object.entries(stats.departments).map(([k, v]) => `- ${k} (${v.name}): ${v.count} faculty (Regular: ${v.regular}, Visiting: ${v.visiting})`).join('\n')}\n`;
      return { actionResult, extraContext };
    }

    // 2. Document Drafting (Leave, Circular, Notice, NOC, Minutes, Syllabus)
    if (
      msg.includes('draft') ||
      msg.includes('leave application') ||
      msg.includes('leave request') ||
      msg.includes('circular') ||
      msg.includes('memo') ||
      msg.includes('invigilation') ||
      msg.includes('noc') ||
      msg.includes('recommendation letter') ||
      msg.includes('meeting minute') ||
      msg.includes('syllabus') ||
      msg.includes('lesson plan')
    ) {
      let docType = 'leave_application';
      if (msg.includes('exam') || msg.includes('invigil')) docType = 'exam_duty';
      else if (msg.includes('noc') || msg.includes('no objection')) docType = 'noc';
      else if (msg.includes('recommendation') || msg.includes('lor')) docType = 'recommendation_letter';
      else if (msg.includes('minute') || msg.includes('meeting')) docType = 'meeting_minutes';
      else if (msg.includes('syllabus') || msg.includes('lesson plan') || msg.includes('curriculum')) docType = 'syllabus';
      else if (msg.includes('circular') || msg.includes('notice')) docType = 'memo';

      const draft = this.draftDocument(docType, { department: targetDept || 'FST' });
      actionResult = { type: 'document_draft', draft };
      extraContext = `\n[OFFICIAL IUHP DRAFT GENERATED]:\nTitle: ${draft.title}\nRef No: ${draft.refNum}\nDate: ${draft.date}\nContent:\n${draft.content}\n`;
      return { actionResult, extraContext };
    }

    // 3. Faculty Search & Directory Lookup
    if (
      msg.includes('find') ||
      msg.includes('search') ||
      msg.includes('who is') ||
      msg.includes('who are') ||
      msg.includes('list faculty') ||
      msg.includes('prof') ||
      msg.includes('dr.') ||
      msg.includes('dean') ||
      msg.includes('faculty') ||
      msg.includes('teacher') ||
      targetDept !== null
    ) {
      let cleanQuery = msg
        .replace(/find|search|who is|who are|list|show|faculty|teachers?|professors?|dr\.?|dean|in|the|at|iuhp|department|of/gi, ' ')
        .replace(/\b(fps|fms|fla|fol|fst)\b/gi, ' ')
        .trim();

      const results = await this.searchFaculty(cleanQuery, targetDept, 6);
      if (results && results.length > 0) {
        actionResult = {
          type: 'faculty_cards',
          count: results.length,
          query: cleanQuery || targetDept,
          department: targetDept,
          employees: results
        };
        extraContext = `\n[MATCHING FACULTY RECORDS FROM DATABASE (${results.length} found)]:\n${results.map((e, idx) => `${idx + 1}. ${e.name} (${e.department}) - ${e.designation} | Qualification: ${e.highestQualification} | Email: ${e.email} | Contact: ${e.contact} | IUHP Tenure: ${e.tenure} | Type: ${e.employmentType}`).join('\n')}\n`;
      }
      return { actionResult, extraContext };
    }

    // 4. Tenure Calculator
    if (msg.includes('tenure') || msg.includes('seniority') || msg.includes('how long has') || msg.includes('years of service')) {
      const dateMatch = msg.match(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/);
      const tenureData = await this.calculateTenure(dateMatch ? dateMatch[0] : '2021-08-01');
      actionResult = { type: 'tenure_result', data: tenureData };
      extraContext = `\n[IUHP TENURE CALCULATION]:\nJoining Date: ${tenureData.joiningDate}\nTenure: ${tenureData.formattedTenure} (${tenureData.exactYears} years)\nSeniority Rank: #${tenureData.seniorityRank} out of ${tenureData.totalFaculty} faculty\n`;
      return { actionResult, extraContext };
    }

    return { actionResult: null, extraContext: '' };
  }

  // System Prompt for NJ.AI
  getSystemPrompt(extraContext = '', persona = 'general', currentUser = null) {
    const userIntro = currentUser ? `\nACTIVE AUTHENTICATED USER (7-Day Verified Session):\n- Name: ${currentUser.name}\n- Department: ${currentUser.department}\n- Role/Designation: ${currentUser.designation || 'Faculty Member'}\n- Official Email: ${currentUser.email}\nAddress the user personally with respect and authority.\n` : '';
    return `You are "NJ.AI" (IUHP Institutional Copilot), the state-of-the-art intelligence system for The ICFAI University, Himachal Pradesh (IUHP).
Your name is strictly "NJ.AI".
${userIntro}
INSTITUTIONAL FOUNDATION:
- University: The ICFAI University, Himachal Pradesh (Act of 2011).
- Campus Location: Baddi, Distt. Solan, H.P. - 174103.
- Core Academic Faculties:
  1. FPS - Faculty of Pharmaceutical Sciences (D.Pharm, B.Pharm, M.Pharm)
  2. FMS - Faculty of Management Studies (BBA, MBA)
  3. FLA - Faculty of Liberal Arts (BA, MA)
  4. FOL - Faculty of Law (LLB, BA LLB)
  5. FST - Faculty of Science & Technology (B.Tech, BCA, MCA, AI, Data Science)
- Domains: @iuhimachal.edu.in, @iuhp.edu.in

YOUR CAPABILITIES AS NJ.AI:
1. Faculty & Employee Intel: Look up faculty records, tenure, contact info, qualifications, and official resumes.
2. Official Academic Drafter: Draft institutional circulars, leave requests, exam duty memos, NOCs, meeting minutes, and syllabi.
3. Campus Analytics: Provide real-time metrics on staff strength, department breakdown, and credentials.
4. Slash Command Assistant: Support instant shortcuts (/faculty, /stats, /leave, /exam, /noc, /lor, /tenure, /syllabus, /minutes, /verify).

STYLE GUIDELINES:
- Deliver clean, authoritative, well-structured answers using markdown (headings, bold points, bulleted lists, and tables).
- Always incorporate and reference live database records provided in [LIVE CAMPUS DATABASE...].
- Maintain an ultra-pleasant, professional, and confident academic persona.
${extraContext}`;
  }

  // Stream completions with automatic fallback and reasoning token support
  async streamCompletions(messages, res, actionResult = null, selectedModel = null) {
    const health = await this.checkHealth();
    const endpointUrl = health.status === 'online' ? this.activeEndpoint : FALLBACK_MODEL_URL;
    const modelToUse = selectedModel || this.activeModel || DEFAULT_MODEL_NAME;

    const postData = JSON.stringify({
      model: modelToUse,
      messages,
      stream: true
    });

    const parsed = new URL(`${endpointUrl}/v1/chat/completions`);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 45000,
      family: 4
    }, (proxyRes) => {
      if (actionResult) {
        res.write(`data: ${JSON.stringify({ type: 'action_result', action: actionResult.type, data: actionResult })}\n\n`);
      }

      proxyRes.on('data', (chunk) => {
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        res.end();
      });
    });

    req.on('timeout', () => {
      req.destroy();
      if (actionResult) {
        res.write(`data: ${JSON.stringify({ type: 'action_result', action: actionResult.type, data: actionResult })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n\n*(Note: NJ.AI request timed out. Campus database action completed.)*' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    req.on('error', (err) => {
      if (actionResult) {
        res.write(`data: ${JSON.stringify({ type: 'action_result', action: actionResult.type, data: actionResult })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n*(Note: NJ.AI local engine notice: ${err.message}. Live campus database results provided above.)*` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    req.write(postData);
    req.end();
  }
}

module.exports = {
  CampusAIService,
  DEPARTMENTS,
  calcTenure,
  PRIMARY_MODEL_URL,
  FALLBACK_MODEL_URL,
  DEFAULT_MODEL_NAME
};
