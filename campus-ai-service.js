/**
 * Campus AI Service - The ICFAI University, Himachal Pradesh (IUHP)
 * Powered by Local Model via Cloudflare Tunnel (qwen2.5:1.5b)
 * Supports live database RAG, tool calling, document drafting, and streaming.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const AI_MODEL_URL = (process.env.AI_MODEL_URL || 'https://month-allocated-contributions-iowa.trycloudflare.com').replace(/\/+$/, '');
const AI_MODEL_NAME = process.env.AI_MODEL_NAME || 'qwen2.5:1.5b';

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
  delete doc.resumeData; // omit large buffer
  delete doc.__v;
  doc.tenure = calcTenure(doc.joiningDate);
  doc.deptInfo = DEPARTMENTS[doc.department] || null;
  return doc;
}

class CampusAIService {
  constructor(models) {
    this.Employee = models.Employee;
    this.RegistrationRequest = models.RegistrationRequest;
  }

  // Health check to verify local model connection
  async checkHealth() {
    const startTime = Date.now();
    return new Promise((resolve) => {
      try {
        const parsed = new URL(`${AI_MODEL_URL}/v1/models`);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(parsed, { method: 'GET', timeout: 6000, family: 4 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latencyMs = Date.now() - startTime;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsedData = JSON.parse(data);
                resolve({
                  status: 'online',
                  latencyMs,
                  model: AI_MODEL_NAME,
                  endpoint: AI_MODEL_URL,
                  models: parsedData.data || []
                });
              } catch (_) {
                resolve({
                  status: 'online',
                  latencyMs,
                  model: AI_MODEL_NAME,
                  endpoint: AI_MODEL_URL,
                  models: [{ id: AI_MODEL_NAME }]
                });
              }
            } else {
              resolve({
                status: 'degraded',
                latencyMs,
                error: `HTTP ${res.statusCode}`,
                endpoint: AI_MODEL_URL
              });
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ status: 'offline', latencyMs: Date.now() - startTime, error: 'Connection timed out', endpoint: AI_MODEL_URL });
        });

        req.on('error', (err) => {
          resolve({ status: 'offline', latencyMs: Date.now() - startTime, error: err.message, endpoint: AI_MODEL_URL });
        });

        req.end();
      } catch (err) {
        resolve({ status: 'offline', latencyMs: Date.now() - startTime, error: err.message, endpoint: AI_MODEL_URL });
      }
    });
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

  // Action: Get Campus Statistics & Breakdown
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
    const refNum = `IUHP/ADMIN/${refYear}/${Math.floor(1000 + Math.random() * 9000)}`;

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

Subject: Application for Leave from ${fromDate} to ${toDate}

Respected Sir / Madam,

I am writing to formally request leave of absence for ${days} day(s), starting from ${fromDate} to ${toDate}, due to ${reason}.

I have arranged for alternate faculty to oversee my scheduled lectures/labs during this duration as per university policy:
- Alternate Faculty Name: ${params.alternateFaculty || '[Name of Colleague]'}
- Department / Course: ${dept}

I will resume my regular academic duties on ${params.resumeDate || '[Resumption Date]'}. I request you to kindly approve my leave application.

Thanking you,

Yours sincerely,

${applicantName}
${designation}, ${deptName}
Employee Contact: ${params.contact || '[Phone Number]'}
Official Email: ${params.email || '[Email Address]'}`
        };

      case 'exam_duty':
      case 'invigilation_notice':
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

Key Guidelines:
1. Reporting Time: Faculty invigilators must report to the Examination Cell 30 minutes prior to exam commencement.
2. Question Paper Collection: Sealed packets must be verified and collected by the Chief Invigilator.
3. Mobile Phones: Strictly prohibited inside examination halls for both students and invigilators.
4. Answer Book Submission: Immediately after completion of exam hours, all sealed answer scripts must be submitted to the Exam Control Room.

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

The University has NO OBJECTION to ${applicantName} applying for / attending:
"${params.purpose || 'Higher Academic Studies / National Conference / Research Collaboration'}" during the academic session ${refYear}-${refYear + 1}.

This certificate is issued on the specific request of the employee for official record and verification purposes.

Registrar / Authorized Signatory
The ICFAI University, Himachal Pradesh
Campus: Baddi, Solan, H.P.`
        };

      case 'recommendation_letter':
        return {
          type: 'Recommendation Letter',
          refNum,
          date: today,
          title: 'LETTER OF ACADEMIC RECOMMENDATION',
          content: `THE ICFAI UNIVERSITY, HIMACHAL PRADESH
${deptName}
Ref: ${refNum}                                              Date: ${today}

CONFIDENTIAL LETTER OF RECOMMENDATION

To Whom It May Concern,

It is my distinct privilege to write this letter of recommendation on behalf of ${params.candidateName || '[Student / Candidate Name]'}, who has been under my academic mentorship at The ICFAI University, Himachal Pradesh.

During their tenure at IUHP, they demonstrated exemplary academic dedication, strong problem-solving acumen, and active participation in institutional projects. Their intellectual curiosity and collaborative spirit set them apart among their peers.

I strongly recommend ${params.candidateName || '[Candidate]'} for ${params.program || 'their prospective higher education program / professional role'} without reservation.

Warm regards,

${applicantName}
${designation}, ${deptName}
The ICFAI University, Himachal Pradesh`
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
  async detectAndExecuteAction(userMessage) {
    const msg = (userMessage || '').toLowerCase();
    let actionResult = null;
    let extraContext = '';

    // Check for explicit or implicit department filter
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
      actionResult = {
        type: 'campus_stats',
        stats
      };
      extraContext = `\n[LIVE CAMPUS DATABASE STATS]:\nTotal Faculty: ${stats.total}\nRegular: ${stats.regularCount}, Visiting: ${stats.visitingCount}\nMissing Photos: ${stats.missingPhotos}\nPending Approvals: ${stats.pendingRequests}\nDepartment breakdown:\n${Object.entries(stats.departments).map(([k, v]) => `- ${k} (${v.name}): ${v.count} faculty (Regular: ${v.regular}, Visiting: ${v.visiting})`).join('\n')}\n`;
      return { actionResult, extraContext };
    }

    // 2. Document Drafting (Leave, Circular, Notice, NOC)
    if (
      msg.includes('draft') ||
      msg.includes('leave application') ||
      msg.includes('leave request') ||
      msg.includes('circular') ||
      msg.includes('memo') ||
      msg.includes('invigilation') ||
      msg.includes('noc') ||
      msg.includes('recommendation letter')
    ) {
      let docType = 'leave_application';
      if (msg.includes('exam') || msg.includes('invigil')) docType = 'exam_duty';
      else if (msg.includes('noc') || msg.includes('no objection')) docType = 'noc';
      else if (msg.includes('recommendation') || msg.includes('lor')) docType = 'recommendation_letter';
      else if (msg.includes('circular') || msg.includes('notice')) docType = 'memo';

      const draft = this.draftDocument(docType, { department: targetDept || 'FST' });
      actionResult = {
        type: 'document_draft',
        draft
      };
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
      // Extract search term by cleaning stop words
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
      actionResult = {
        type: 'tenure_result',
        data: tenureData
      };
      extraContext = `\n[IUHP TENURE CALCULATION]:\nJoining Date: ${tenureData.joiningDate}\nTenure: ${tenureData.formattedTenure} (${tenureData.exactYears} years)\nSeniority Rank: #${tenureData.seniorityRank} out of ${tenureData.totalFaculty} faculty\n`;
      return { actionResult, extraContext };
    }

    return { actionResult: null, extraContext: '' };
  }

  // Build Comprehensive System Prompt for Campus AI
  getSystemPrompt(extraContext = '') {
    return `You are "Campus AI" (IUHP Campus Copilot), the state-of-the-art intelligent campus assistant for The ICFAI University, Himachal Pradesh (IUHP).
You are running locally on the university's private AI server powered by Qwen 2.5 (1.5B) via Cloudflare Tunnel.

IUHP INSTITUTIONAL CONTEXT:
- University: The ICFAI University, Himachal Pradesh (Established under The ICFAI University Act, 2011).
- Campus Location: Baddi, Distt. Solan, Himachal Pradesh - 174103.
- Five Core Academic Faculties:
  1. FPS - Faculty of Pharmaceutical Sciences (Dean, Pharmacy, D.Pharm, B.Pharm, M.Pharm)
  2. FMS - Faculty of Management Studies (BBA, MBA, Commerce)
  3. FLA - Faculty of Liberal Arts (BA, MA, Humanities)
  4. FOL - Faculty of Law (BA LLB, LLB, LLM)
  5. FST - Faculty of Science & Technology (B.Tech, BCA, MCA, Computer Science, AI, Data Science)
- Official Email Domains: @iuhimachal.edu.in and @iuhp.edu.in
- Key Campus Systems: Faculty Directory, Leave Management, Syllabus & Lesson Planning, Exam Invigilation, Research Publications, and Student Advising.

YOUR ROLES & CAPABILITIES:
1. Faculty & Employee Copilot: Lookup faculty profiles, contact details, official resumes, departments, and designations.
2. Academic & Administrative Drafting: Draft official leave applications, circulars, exam duty memos, NOCs, course syllabi, and letters of recommendation in authentic IUHP format.
3. Campus Analytics: Provide accurate live statistics on faculty counts, regular vs visiting staff, and department strength.
4. Professional & Polite: Deliver clear, authoritative, well-formatted answers using markdown (headings, bullet points, tables, bold key points).

IMPORTANT INSTRUCTIONS:
- Whenever live database results or drafts are provided in [LIVE CAMPUS DATABASE...], ALWAYS use them accurately and refer to them.
- Be concise, respectful, academic, and direct.
- For drafts, provide the complete, ready-to-use text with IUHP letterhead styling.
${extraContext}`;
  }

  // Stream completions from Ollama / Cloudflare
  streamCompletions(messages, res, actionResult = null) {
    const postData = JSON.stringify({
      model: AI_MODEL_NAME,
      messages,
      stream: true
    });

    const parsed = new URL(`${AI_MODEL_URL}/v1/chat/completions`);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000,
      family: 4
    }, (proxyRes) => {
      // If action result was detected, send it first
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
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n\n*(Note: Campus AI connection timed out. Live campus database action completed successfully.)*' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    req.on('error', (err) => {
      if (actionResult) {
        res.write(`data: ${JSON.stringify({ type: 'action_result', action: actionResult.type, data: actionResult })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n*(Note: Local model response unavailable: ${err.message}. Live campus database results provided.)*` } }] })}\n\n`);
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
  AI_MODEL_URL,
  AI_MODEL_NAME
};
