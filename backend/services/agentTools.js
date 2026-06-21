// ---------------------------------------------------------------------------
// Agentic tool definitions + dispatcher for the Priya agentic LLM path.
//
// The agent (Groq tool-calling) proposes field values and actions; this
// module validates and applies them. Nothing here trusts the LLM — every
// save_detail call is range/enum/length checked before it lands in
// session.collected.
// ---------------------------------------------------------------------------
const vectorStore = require('./vectorStore')

// ── Field spec ──────────────────────────────────────────────────────────────

const ALLOWED_FIELDS = [
  'caller_type', 'parent_name', 'relation', 'student_name',
  'marks_10', 'marks_inter', 'interest', 'department',
  'entrance_exam', 'entrance_score',
  'location', 'transport_need', 'visit_appointment',
]

const has = (v) => typeof v === 'string' ? v.trim().length > 0 : v != null

// Pull the first plausible marks value out of vague / filler-laden phrasing such
// as "around 71", "like 65 percent", "71 ish", "71%", or "7.8 cgpa". Returns a
// normalised string ("71%" for percentages, bare "8.5" for CGPA ≤ 10) or null if
// no in-range number is present. A leading minus is preserved so "-1" is rejected
// upstream by the 0-100 bound rather than silently matching "1".
function extractMarksValue(rawValue) {
  // Strip ordinals ("10th", "12th") and class words so "my 10th class is 99.5"
  // yields 99.5, not 10.
  const cleaned = String(rawValue ?? '')
    .replace(/\b\d{1,2}\s*(st|nd|rd|th)\b/gi, ' ')
    .replace(/\b(class|grade|standard|std|inter|intermediate)\b/gi, ' ')
  const nums = cleaned.match(/-?\d{1,3}(?:\.\d+)?/g)
  if (!nums) return null
  // A leading 10/11/12 is usually the class reference, not the score
  // ("my 10% is like 78" → 78). If a later number exists, prefer it.
  let pick = nums[0]
  if (nums.length > 1 && [10, 11, 12].includes(parseInt(nums[0], 10))) pick = nums[1]
  const n = parseFloat(pick)
  if (isNaN(n) || n < 0 || n > 100) return null
  // > 10 ⇒ unambiguously a percentage; ≤ 10 ⇒ treat as CGPA and keep it bare.
  return n > 10 ? `${n}%` : String(n)
}

// Lightly clean a spoken answer into a storable value for a text field — strip
// lead-in fillers ("yes", "like", "I am from the", "it's") without mangling the
// substance. Returns null if nothing usable remains.
function cleanTextValue(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.replace(/^(yes|yeah|yep|ok|okay|sure|so|well|like|um|uh|actually)[,\s]+/i, '')
  s = s.replace(/^(i\s*am|i'?m|i)\s+(interested\s+in|from|located\s+(?:in|at|from)?|in|studying)\s+/i, '')
  s = s.replace(/^(my\s+(?:name|city|location|place)\s+is|it'?s|that'?s)\s+/i, '')
  // Translate-in off: raw Telugu/Hindi hits this directly, so strip the in-language
  // "my name is" lead-in to save just the name. Telugu: optional "నా/మా/నీ" + "పేరు"
  // + optional connector "వచ్చి/అని" (so "పేరు వచ్చి రాహుల్" → "రాహుల్", "నా పేరు
  // కార్తీక్" → "కార్తీక్"); Hindi: "मेरा/मेरी नाम [है]". Trailing "అని"/"है" too.
  s = s.replace(/^(నా|మా|నీ|మై)?\s*(పేరు|నేమ్)\s*(వచ్చి|అని)?\s*/u, '')
  s = s.replace(/^(मेरा|मेरी)?\s*(नाम|नेम)\s*(है)?\s*/u, '')
  s = s.replace(/\s*(అని|है)\s*$/u, '')
  s = s.replace(/^the\s+/i, '')
  s = s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  return s.length ? s : null
}

// Best-effort value for the field currently being collected, from a spoken turn.
// Used by the save-guard so the agent never drops an answer and re-asks — AND so
// simple data-collection turns resolve in a single Groq call instead of two (a
// save_detail round-trip + a reply round-trip), which roughly halves turn latency.
// Numeric marks use extractMarksValue; names/location are lightly cleaned;
// caller_type is keyword-matched. interest/department are left to the model (it
// normalises e.g. "CSC" → "CSE"); relation/transport_need enums are left too.
function valueForPendingField(field, message) {
  if (field === 'marks_10' || field === 'marks_inter') return extractMarksValue(message)
  if (field === 'location') {
    const v = cleanTextValue(message)
    return v && v.length >= 2 ? v : null
  }
  if (field === 'student_name' || field === 'parent_name') {
    const v = cleanTextValue(message)
    if (!v || v.length < 2) return null
    // "I am a student/parent" is a caller_type answer, not a name — don't save it.
    if (/\b(student|parent|father|mother|mom|dad|guardian)\b/i.test(v) ||
        /^(స్టూడెంట్|విద్యార్థి|పేరెంట్|छात्र|स्टूडेंट)$/u.test(v)) return null
    return v
  }
  if (field === 'caller_type') {
    // English + Telugu/Hindi. Translate-in is off, so the STT hands us native script;
    // it transliterates spoken English too ("student" → "స్టూడెంట్", "parent" →
    // "పేరెంట్"), and callers also use native words (విద్యార్థి, తల్లి, తండ్రి…).
    if (/\b(parent|father|mother|mom|dad|guardian)\b/i.test(message) ||
        /పేరెంట్|తల్లి|తండ్రి|అమ్మ|నాన్న|సంరక్షకు|पैरंट|अभिभावक|माता|पिता|माँ|पापा/u.test(message)) return 'parent'
    if (/\b(student|myself)\b/i.test(message) || /\bi'?m the student\b/i.test(message) ||
        /స్టూడెంట్|స్టుడెంట్|విద్యార్థి|छात्र|स्टूडेंट|विद्यार्थी/u.test(message)) return 'student'
    return null
  }
  return null
}

function validateField(field, rawValue) {
  const value = String(rawValue ?? '').trim()

  switch (field) {
    case 'caller_type':
      if (!['student', 'parent'].includes(value.toLowerCase())) {
        return { ok: false, error: 'caller_type must be "student" or "parent"' }
      }
      return { ok: true, value: value.toLowerCase() }

    case 'relation':
      if (!['father', 'mother', 'guardian'].includes(value.toLowerCase())) {
        return { ok: false, error: 'relation must be one of: father, mother, guardian' }
      }
      return { ok: true, value: value.toLowerCase() }

    case 'transport_need':
      if (!['college_bus', 'hostel', 'own_transport'].includes(value.toLowerCase())) {
        return { ok: false, error: 'transport_need must be one of: college_bus, hostel, own_transport' }
      }
      return { ok: true, value: value.toLowerCase() }

    case 'marks_10':
    case 'marks_inter': {
      // Tolerate vague phrasing ("around 71", "like 65 percent", "71 ish") by
      // extracting the number before validating — the bound stays 0-100.
      const norm = extractMarksValue(value)
      if (norm === null) {
        return { ok: false, error: `${field} must be a number between 0 and 100 (percentage) or 0 and 10 (CGPA)` }
      }
      return { ok: true, value: norm }
    }

    case 'entrance_score': {
      const n = parseFloat(value)
      if (isNaN(n) || n < 0) {
        return { ok: false, error: 'entrance_score must be a non-negative number' }
      }
      return { ok: true, value: String(n) }
    }

    case 'student_name':
    case 'parent_name':
      if (value.length < 2 || value.length > 50) {
        return { ok: false, error: `${field} must be between 2 and 50 characters` }
      }
      return { ok: true, value }

    case 'interest':
    case 'department':
    case 'location':
    case 'entrance_exam':
    case 'visit_appointment':
      if (!value.length || value.length > 100) {
        return { ok: false, error: `${field} must be a non-empty string up to 100 characters` }
      }
      return { ok: true, value }

    default:
      return { ok: false, error: `Unknown field "${field}"` }
  }
}

// ── Dynamic required-fields logic ────────────────────────────────────────────

function getRequiredFields(collected = {}) {
  const fields = ['caller_type']

  if (collected.caller_type === 'parent') {
    fields.push('parent_name', 'relation', 'student_name', 'marks_10', 'marks_inter', 'interest', 'department')
  } else {
    fields.push('student_name', 'marks_10', 'marks_inter', 'interest', 'department')
  }

  fields.push('location', 'transport_need', 'visit_appointment')
  return fields
}

function getMissingFields(session) {
  const c = session?.collected || {}
  return getRequiredFields(c).filter(f => !has(c[f]))
}

// Short, warm fallback question per field — used when a weak model dumps the whole
// collection list instead of asking one thing (see looksLikeFieldDump). Keeps the
// call moving with a single clear question for whatever's next.
const FIELD_QUESTIONS = {
  caller_type:       'Am I speaking with the student, or a parent?',
  parent_name:       'May I know your name, please?',
  relation:          'Are you the father, mother, or guardian?',
  student_name:      "And the student's name, please?",
  marks_10:          'What was your 10th class percentage?',
  marks_inter:       'And your 12th or Intermediate percentage?',
  interest:          'Which course are you interested in — like B.Tech, MBA or Degree?',
  department:        'Which branch would you like — for example CSE or ECE?',
  location:          'Which city are you reaching out from?',
  transport_need:    'Would you prefer the college bus, the hostel, or your own transport?',
  visit_appointment: 'Would you like to book a campus visit?',
}
function defaultQuestionFor(session) {
  const f = getMissingFields(session)[0]
  return FIELD_QUESTIONS[f] || 'Could you tell me a little more about what you need?'
}

// Detect a model that regurgitated the whole field list instead of asking ONE thing
// (a frequent small-model failure): "provide the following details", 3+ bullets, or
// several field names crammed into one reply.
function looksLikeFieldDump(text) {
  const t = String(text || '')
  if (/provide the following|following details|following information/i.test(t)) return true
  if (((t.match(/(?:^|[\s])[-•*]\s/g) || []).length) >= 3) return true
  const fields = (t.match(/caller type|student'?s name|10th|12th|ssc|hsc|course of interest|department\/branch|branch of interest|transportation needs|campus visit/gi) || []).length
  return fields >= 3
}

// ── deriveStep — map collected progress onto the existing 12-step UI ────────

function deriveStep(session) {
  const c = session?.collected || {}

  // Forced terminal states
  if (c._escalate || c._endCall) return { step: 'end', step_index: 11 }

  if (!has(c.caller_type)) return { step: 'greeting', step_index: 0 }

  const nameDone = c.caller_type === 'parent'
    ? has(c.parent_name) && has(c.relation) && has(c.student_name)
    : has(c.student_name)
  if (!nameDone) return { step: 'name', step_index: 1 }

  if (!has(c.marks_10))    return { step: '10th',  step_index: 2 }
  if (!has(c.marks_inter)) return { step: 'inter', step_index: 3 }
  if (!has(c.interest) || !has(c.department)) return { step: 'course', step_index: 4 }

  // index 5 (fee) and 7 (scholarship) gate on facts having been shared;
  // index 6 (exam) is intentionally skipped — the agentic flow has no
  // entrance-exam field, so progress jumps 5 → 7.
  if (!c._packageShared)    return { step: 'fee',         step_index: 5 }
  if (!c._scholarshipShared) return { step: 'scholarship', step_index: 7 }

  if (!has(c.location))       return { step: 'location',  step_index: 8 }
  if (!has(c.transport_need)) return { step: 'transport',  step_index: 9 }
  if (!has(c.visit_appointment)) return { step: 'queries', step_index: 10 }

  return { step: 'end', step_index: 11 }
}

// ── Tool definitions (Groq / OpenAI-compatible function-calling schema) ─────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'save_detail',
      description: 'Save a single piece of information the caller has just provided. Call this as soon as you hear a relevant fact, even mid-sentence.',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ALLOWED_FIELDS, description: 'Which field this value belongs to.' },
          value: { type: 'string', description: 'The value to save, as a string.' },
        },
        required: ['field', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_missing_fields',
      description: 'Check which required fields are still missing for this caller (student vs parent requirements differ).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_course_package',
      description: 'Retrieve real fee/package information for a course and department from the university knowledge base. Only state facts returned by this tool.',
      parameters: {
        type: 'object',
        properties: {
          course:     { type: 'string', description: 'The course the student is interested in, e.g. "B.Tech".' },
          department: { type: 'string', description: 'The department/specialization, e.g. "Computer Science".' },
        },
        required: ['course', 'department'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_scholarships',
      description: 'Retrieve real scholarship eligibility information from the university knowledge base based on the student\'s marks and entrance score. Only state facts returned by this tool.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transport_info',
      description: 'Retrieve real hostel and bus/transport information from the university knowledge base. Only state facts returned by this tool.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_campus_visit',
      description: 'Book a campus visit once the caller has agreed on a day and time.',
      parameters: {
        type: 'object',
        properties: {
          day:  { type: 'string', description: 'The day for the visit, e.g. "Saturday" or "2026-06-20".' },
          time: { type: 'string', description: 'The time for the visit, e.g. "11 AM".' },
        },
        required: ['day', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_call',
      description: 'End the call politely once all necessary information has been collected and confirmed.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief reason the call is ending.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Escalate to a human admission counsellor — use if the caller explicitly asks for a human, is upset, or you cannot help with their request.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief reason for escalation.' },
        },
      },
    },
  },
]

// ── RAG result compaction ───────────────────────────────────────────────────
// KB chunks are large multi-program tables. Dumping 3 of them whole (several KB)
// into the synthesis call blows the latency budget. Compact aggressively: from
// each of the top chunks keep the sentences most relevant to `focus` (the
// student's course/department/etc.), ranked by how many focus terms they hit, and
// cap each chunk so the whole payload stays well under ~1KB while still carrying
// the specific figure the agent needs to quote.
function compactFacts(results, focus = [], perChunk = 300, maxChunks = 3) {
  // Most specific terms first (e.g. department before course) so the window
  // centres on the student's row. Use a contiguous slice — never sentence
  // fragments — so figures like "Rs. 2,75,000 per year" are never orphaned.
  const keys = focus.filter(Boolean).map(s => String(s).toLowerCase()).filter(s => s.length > 1)

  const pick = (text) => {
    if (keys.length) {
      const lower = text.toLowerCase()
      let idx = -1
      for (const k of keys) { const j = lower.indexOf(k); if (j >= 0) { idx = j; break } }
      if (idx >= 0) {
        const start = Math.max(0, idx - 30)
        const end   = Math.min(text.length, start + perChunk)
        return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
      }
    }
    return text.length > perChunk ? text.slice(0, perChunk).trim() + '…' : text.trim()
  }

  return results.slice(0, maxChunks).map(r => pick(r.text)).filter(Boolean).join(' | ')
}

// ── Tool execution ────────────────────────────────────────────────────────

async function executeTool(sessionId, toolName, args = {}, collected = {}) {
  switch (toolName) {

    case 'save_detail': {
      const { field, value } = args
      if (!ALLOWED_FIELDS.includes(field)) {
        return { result: `Error: unknown field "${field}". Allowed fields: ${ALLOWED_FIELDS.join(', ')}`, collectedPatch: {} }
      }
      const v = validateField(field, value)
      if (!v.ok) return { result: `Error: ${v.error}`, collectedPatch: {} }
      return { result: `Saved ${field} = ${v.value}`, collectedPatch: { [field]: v.value } }
    }

    case 'get_missing_fields': {
      const missing = getMissingFields({ collected })
      return {
        result: missing.length ? `Missing fields: ${missing.join(', ')}` : 'All required fields have been collected.',
        collectedPatch: {},
      }
    }

    case 'get_course_package': {
      // Prefer the student's actual course/department (from collected) so the
      // search ranks their specific row, not the whole program table.
      const course     = String(args.course     || collected.interest   || '').trim()
      const department = String(args.department || collected.department || '').trim()
      const query   = [course, department, 'fee structure tuition'].filter(Boolean).join(' ')
      const results = await vectorStore.search(query, 3)
      const facts   = compactFacts(results, [department, course], 300, 3)
      return {
        result: facts || 'No specific package information found in the knowledge base — give only general, non-specific encouragement and do not state any fee figures.',
        collectedPatch: { _packageShared: true },
      }
    }

    case 'get_scholarships': {
      const query   = ['scholarship eligibility', collected.department, collected.interest,
                       collected.marks_10, collected.marks_inter, collected.entrance_score]
        .filter(Boolean).join(' ') || 'scholarship'
      const results = await vectorStore.search(query, 3)
      const facts   = compactFacts(results, [collected.department, collected.interest], 280, 2)
      return {
        result: facts || 'No specific scholarship information found in the knowledge base — do not state any scholarship figures.',
        collectedPatch: { _scholarshipShared: true },
      }
    }

    case 'get_transport_info': {
      const query   = ['hostel bus transport facilities', collected.location].filter(Boolean).join(' ')
      const results = await vectorStore.search(query, 3)
      const facts   = compactFacts(results, [collected.location], 300, 3)
      return {
        result: facts || 'No specific transport/hostel information found in the knowledge base.',
        collectedPatch: {},
      }
    }

    case 'book_campus_visit': {
      const day  = String(args.day  || '').trim()
      const time = String(args.time || '').trim()
      if (!day || !time) {
        return { result: 'Error: both day and time are required to book a campus visit', collectedPatch: {} }
      }
      const appointment = `${day} at ${time}`
      return {
        result: `Campus visit booked for ${appointment}. (TODO: sync to calendar)`,
        collectedPatch: { visit_appointment: appointment },
      }
    }

    case 'end_call': {
      const reason = String(args.reason || 'conversation complete')
      return { result: `Ending call: ${reason}`, collectedPatch: { _endCall: true } }
    }

    case 'escalate_to_human': {
      const reason = String(args.reason || 'requested by caller')
      return { result: `Escalating to a human counsellor: ${reason}`, collectedPatch: { _escalate: true } }
    }

    default:
      return { result: `Error: unknown tool "${toolName}"`, collectedPatch: {} }
  }
}

// ── System prompt ─────────────────────────────────────────────────────────

const LANG_NAMES = { 'te-IN': 'Telugu', 'hi-IN': 'Hindi', 'ta-IN': 'Tamil', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'bn-IN': 'Bengali', 'en-IN': 'English' }

function buildAgenticSystemPrompt(session, opts = {}) {
  const c = session?.collected || {}
  const profile = Object.entries(c)
    .filter(([k, v]) => !k.startsWith('_') && has(v))
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'none yet'

  const pendingField = getMissingFields(session)[0] || null

  // Reply-language instruction. Default: reply in English (Sarvam translates after).
  // Native mode (opts.replyLanguage set): reply DIRECTLY in the caller's language,
  // in natural code-mixed phone style — no translation step downstream.
  const lang = opts.replyLanguage && opts.replyLanguage !== 'en-IN' ? opts.replyLanguage : null
  const langName = lang ? (LANG_NAMES[lang] || lang) : null
  const replyInstruction = lang
    ? `Reply directly in ${langName}, the way people actually talk on the phone — natural, modern, freely CODE-MIXED. Write the sentence in ${langName} script but keep common English words in English (fee, scholarship, course, B.Tech, CSE, percentage, marks, campus, hostel, branch, university) and keep numbers as plain digits (e.g. 2,75,000 — never native-script digits). NEVER translate proper nouns, acronyms or programme names — "Aditya University", "B.Tech", "CSE", "SAP", "Google Cloud" stay EXACTLY as written; never invent a native-language word for them. Do NOT use pure/formal ${langName}; mix English naturally like a real bilingual ${langName} speaker. Do not write any English-only sentence — your reply is spoken aloud directly with no translation.`
    : `Always reply in English — translation to the caller's language happens automatically after you respond.`

  return `You are Priya, a warm and persuasive admission counsellor at Aditya University, on a phone call with a prospective student or their parent.

LANGUAGE: You are fluent in Telugu, Hindi and English, and the system speaks your reply in whichever language the caller wants. If the caller asks you to switch language (e.g. "speak in Telugu"), simply agree warmly and continue answering their question — NEVER say you cannot change language or that you only speak English. Do not announce the switch repeatedly; just keep helping.

PHONE STYLE: Speak in a warm, friendly, conversational way — like a caring family friend who happens to work at the university, not a form-filler reading a script. Use the caller's name naturally, sound relaxed and human (a little "that's wonderful!", "no worries", "I completely understand"). ${replyInstruction}

KEEP IT SHORT (this is a phone call — long replies take many seconds to speak and break the call):
- Reply with ONE short sentence: a quick acknowledgement plus AT MOST one question — aim for 15 words, HARD MAX ~25. Never two long sentences.
- Collect ONE detail at a time. NEVER list the fields you need, never ask the caller to "provide the following details", and never request several things (name, marks, course…) in one breath — ask for just the single next thing.
- NEVER write the same question two different ways, never repeat yourself, and NEVER narrate what you are doing or which tool you will call (the caller must not hear "we need to call get_scholarships" or similar).
- Even when presenting fee / scholarships / placements / course details: share ONLY the single most relevant fact (one figure or one strength) plus a short check-in question. NEVER list multiple items, never enumerate programs, never read out a paragraph — the rest can come if they ask. A reply longer than ~25 words is too long and will be cut off mid-sentence.

BE CONVINCING (you are selling Aditya University):
- Warmly acknowledge what the caller just said before moving on (e.g. "That's a great score, Karthik!", "CSE is an excellent choice!").
- At the fee, scholarship, placements, hostel/transport and campus-visit moments, actively persuade: highlight the university's strengths — strong placements, industry-collaboration programs (e.g. SAP, Google Cloud, Microsoft), the scholarship they personally qualify for, and campus life — using ONLY the real facts the tools return.
- Build genuine excitement and gently nudge them toward the next step (their scholarship, a campus visit, applying). Never pressure, never invent figures.

CHECK FOR AGREEMENT (don't just dump info and rush on):
- After you share the fee/package, gently ask whether it works for them — e.g. "How does that sound?" or "Is that comfortable for you?" — and WAIT for their reaction before moving on.
- If they hesitate or say it's high, warmly reassure them and bring up the scholarships they qualify for to bring the cost down — never get defensive, never pressure.
- Do the same light "does that sound good?" check before booking a campus visit. Make it feel like a friendly conversation, not a checklist.

YOUR PLAYBOOK (follow in this order):
1. The call opens by asking the caller's preferred language (Telugu, English, Hindi, or another). When they tell you, warmly acknowledge it (e.g. "Telugu, wonderful!") and move on — never re-ask the language.
2. Ask whether you are speaking with the student or a parent/guardian.
3. If a PARENT/guardian: first get parent_name, then the relation (father / mother / guardian), then the student's name. If the STUDENT: just get student_name. Every marks and course question after this is about the STUDENT.
4. Collect the student's marks_10 (10th / SSC percentage or CGPA), then marks_inter (12th / Intermediate percentage).
5. Ask which course or program the student wants (interest) — e.g. B.Tech, MBA, Degree.
6. THEN, as a separate question, ask the specific department / branch (e.g. CSE, ECE, Mechanical) for that course.
7. Once interest and department are known, call get_course_package and warmly present the package — fee, course and branch. After sharing the fee, gently CHECK IN — ask how that sounds or whether it's comfortable for them — and wait for their reaction before moving on. Use ONLY the facts the tool returns; never invent numbers, never pressure.
8. Whether they're happy or hesitant about the fee, call get_scholarships and reassure/convince them with the specific scholarships the student qualifies for to bring the cost down (only the real figures the tool returns).
9. Collect location and transport_need (college_bus / hostel / own_transport). Use get_transport_info for hostel/bus facts.
10. Offer a campus visit. If the caller agrees on a day and time, call book_campus_visit to book the appointment.
11. Confirm the key collected details in one sentence.
12. Call end_call to wrap up politely.

TOOLS AVAILABLE:
- save_detail(field, value): save ANY piece of information as soon as the caller mentions it.
- get_missing_fields(): check what is still needed.
- get_course_package(course, department), get_scholarships(), get_transport_info(): retrieve real facts — quote them, never invent.
- book_campus_visit(day, time): book once the caller agrees on both.
- end_call(reason): end the call once everything is collected and confirmed.
- escalate_to_human(reason): use if the caller asks for a human, is upset, or you cannot help.

RULES:
- NEVER fabricate fees, scholarships, rankings, or facilities — only state what the tools return.
- Save details with save_detail as soon as you hear them, even mid-sentence.
- Keep replies short, natural, and warm — like a real phone conversation.

CURRENTLY COLLECTING: ${pendingField || '(all required details collected)'}

FLOW GATES (do not violate):
- You MUST learn whether you're speaking with the STUDENT or a PARENT/guardian BEFORE asking for anyone's name. If CURRENTLY COLLECTING is caller_type, your ONLY next question is "Am I speaking with the student, or a parent?" — do not ask for a name yet.
- NEVER assume student vs parent. Only ask for the "child's name" if the caller has actually confirmed they are a parent; otherwise ask for "your name".
- Ask for exactly the field in CURRENTLY COLLECTING — do not skip ahead.

HANDLING UNCLEAR INPUT:
- If the caller's reply is empty, unintelligible, or clearly mis-transcribed (random words, or a different language than expected), warmly say you didn't catch that and ask them to repeat. NEVER guess, invent, or move on based on garbled input.

CRITICAL SAVE RULE:
- Before you ask your next question, you MUST call save_detail for whatever the caller just told you. This applies to EVERY field — name, 10th and 12th marks (even vague ones like "around 71"), course, department, and city/location — not only numbers.
- NEVER ask the same question twice. If the caller has already answered (even partially or vaguely, like "Odisha, Chhatrapur city"), save what they gave and move on to the next field.
- BUT if the caller did NOT actually give the value — e.g. they trailed off with no number for a marks question, or the words were garbled/unclear — gently ask once more for that specific field. Do NOT skip ahead to the next topic with the field still empty.
- Bind the answer to the field named in CURRENTLY COLLECTING (the field you most recently asked about). Only ask for clarification when no field is pending.

CALLER PROFILE SO FAR: ${profile}`
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  validateField,
  extractMarksValue,
  valueForPendingField,
  getRequiredFields,
  getMissingFields,
  defaultQuestionFor,
  looksLikeFieldDump,
  deriveStep,
  buildAgenticSystemPrompt,
  ALLOWED_FIELDS,
}
