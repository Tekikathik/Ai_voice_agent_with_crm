// ---------------------------------------------------------------------------
// Priya Admin API Routes
//
//  POST /api/priya/trigger-call   — start a new session + Twilio outbound call
//  GET  /api/priya/sessions/:id   — poll session state (step, transcript, etc.)
//  GET  /api/priya/calls          — last 20 completed calls (call history)
// ---------------------------------------------------------------------------
const router         = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const sessionStore   = require('../services/sessionStore')
const twilioOutbound = require('../services/twilioOutbound')
const priyaService   = require('../services/priya')

// Map UI dropdown labels → API values
// 'Auto detect' maps to null so STT can detect freely; explicit selections are "locked"
const LANGUAGE_MAP = {
  English:       'en-IN',
  Telugu:        'te-IN',
  Hindi:         'hi-IN',
  'Auto detect': null,
}
const STYLE_MAP = {
  'Modern Colloquial': 'modern_colloquial',
  Formal:              'formal',
  Classic:             'classic',
}
const AUDIENCE_MAP = {
  International: 'international',
  Domestic:      'domestic',
}

// ---------------------------------------------------------------------------
// Mock simulation — runs in the background when Twilio is not configured.
// Calls Priya API with realistic student responses so the dashboard shows a
// live conversation without needing a real phone call.
// ---------------------------------------------------------------------------
const MOCK_STUDENT_REPLIES = [
  'My name is Rahul Sharma',
  'I got 85 percent in 10th',
  'Inter marks are 78 percent',
  'I am interested in B.Tech Computer Science',
  'What are the fee details?',
  'Have I appeared in JEE? Yes, I got 120 marks',
  'Is there any scholarship available?',
  'I am from Hyderabad',
  'Do you have bus facility from Ameerpet?',
  'No more questions, thank you',
]

// Fallback script used when the Priya LLM API is unreachable (503 / offline).
// Each entry: [priya_reply, step_name, step_index, collected_patch]
const FALLBACK_SCRIPT = [
  ['Namaste! I am Priya from Aditya University admissions. May I know your good name please?',
    'name', 0, {}],
  ['Thank you! Could you please share your 10th class percentage?',
    '10th', 1, { name: 'Rahul Sharma' }],
  ['That\'s great! And what percentage did you score in Intermediate / 12th?',
    'inter', 2, { marks_10: '85' }],
  ['Excellent! Which course are you interested in at our university?',
    'course', 3, { marks_inter: '78' }],
  ['Good choice! Our B.Tech CSE program is excellent. Shall I share the fee details?',
    'fee', 4, { interest: 'B.Tech Computer Science' }],
  ['The annual tuition fee is ₹1.2 Lakhs with hostel at ₹80K. Have you appeared in any entrance exam?',
    'exam', 5, {}],
  ['Good score! Based on your JEE rank you may qualify for a merit scholarship. Shall I check?',
    'scholarship', 6, {}],
  ['You may be eligible for up to 30% scholarship. Where are you currently located?',
    'location', 7, {}],
  ['We have bus facility from Hyderabad, Vijayawada and Rajahmundry. Do you need transport?',
    'transport', 8, { location: 'Hyderabad' }],
  ['Transport pass is available at ₹18K per year. Do you have any other questions?',
    'queries', 9, {}],
  ['I\'ll send the complete brochure and fee structure to your WhatsApp. Our team will follow up in 24 hours. Thank you!',
    'end', 11, {}],
]

async function callPriyaWithFallback(sessionId, message, fallbackIndex) {
  try {
    const data = await priyaService.callPriyaAPI(sessionId, message)
    // If API returns a valid reply use it; otherwise fall back
    if (data && data.reply) return { ...data, usedFallback: false }
  } catch (err) {
    console.warn(`[MockSim] Priya API unavailable (${err.message}), using fallback script`)
  }
  // Use local fallback script
  const [reply, step, step_index, collected] = FALLBACK_SCRIPT[Math.min(fallbackIndex, FALLBACK_SCRIPT.length - 1)]
  return { reply, step, step_index, collected, usedFallback: true }
}

async function runMockSimulation(sessionId) {
  const delay = ms => new Promise(r => setTimeout(r, ms))

  try {
    // Simulate ring delay
    await delay(2000)
    sessionStore.update(sessionId, { status: 'in-progress', detected_language: 'en-IN' })

    // Turn 0 — opening greeting
    let fallbackIdx = 0
    let priyaRes = await callPriyaWithFallback(sessionId, 'Hello', fallbackIdx)
    let { reply, step, step_index, collected } = priyaRes
    let session = sessionStore.get(sessionId)

    sessionStore.update(sessionId, {
      step, step_index,
      collected: { ...session.collected, ...collected },
      transcript: [
        ...session.transcript,
        { role: 'Priya', text: reply, timestamp: new Date().toISOString() },
      ],
    })

    // Walk through mock student replies turn by turn
    for (const studentText of MOCK_STUDENT_REPLIES) {
      await delay(3500)
      session = sessionStore.get(sessionId)
      if (!session || session.status !== 'in-progress') break

      // Student speaks
      sessionStore.update(sessionId, {
        transcript: [
          ...sessionStore.get(sessionId).transcript,
          { role: 'Student', text: studentText, timestamp: new Date().toISOString() },
        ],
      })

      await delay(1200)
      session = sessionStore.get(sessionId)
      if (!session || session.status !== 'in-progress') break

      // Priya responds (real API or fallback)
      fallbackIdx++
      priyaRes = await callPriyaWithFallback(sessionId, studentText, fallbackIdx)
      ;({ reply, step, step_index, collected } = priyaRes)

      const s = sessionStore.get(sessionId)
      sessionStore.update(sessionId, {
        step, step_index,
        collected: { ...s.collected, ...collected },
        transcript: [
          ...s.transcript,
          { role: 'Priya', text: reply, timestamp: new Date().toISOString() },
        ],
      })

      if (step === 'end' || step_index >= 11) break
    }

    // Finalise
    await delay(2000)
    const final = sessionStore.get(sessionId)
    if (final) {
      const duration = Math.floor((Date.now() - new Date(final.start_time).getTime()) / 1000)
      sessionStore.update(sessionId, { status: 'completed', duration })
      sessionStore.saveToHistory(sessionStore.get(sessionId))
      console.log(`[MockSim] Session ${sessionId} completed (${duration}s)`)
    }
  } catch (err) {
    console.error('[MockSim] Fatal error:', err.message)
    sessionStore.update(sessionId, { status: 'failed' })
  }
}

// ---------------------------------------------------------------------------
// POST /api/priya/trigger-call
// ---------------------------------------------------------------------------
router.post('/trigger-call', async (req, res) => {
  try {
    const {
      phone,
      name       = '',
      language   = 'Auto detect',
      style      = 'Modern Colloquial',
      audience   = 'International',
      gender     = 'Female',
      smart_mode = false,
    } = req.body

    if (!phone) return res.status(400).json({ message: 'phone is required' })

    // Normalise to E.164 +91XXXXXXXXXX format
    const digits = String(phone).trim().replace(/\s+/g, '').replace(/^\+?91/, '').replace(/^0/, '')
    const normalizedPhone = `+91${digits}`

    const sessionId = uuidv4()

    const preferredLang = LANGUAGE_MAP[language]  // null = auto-detect, 'te-IN'/'hi-IN'/'en-IN' = locked
    sessionStore.create(sessionId, {
      phone: normalizedPhone,
      name:              name || null,
      preferred_language: preferredLang,                    // admin selection; null = auto
      detected_language:  preferredLang || 'en-IN',         // runtime detected; starts as preference
      style:             STYLE_MAP[style]       || 'modern_colloquial',
      audience:          AUDIENCE_MAP[audience] || 'international',
      gender,
      smart_mode:        Boolean(smart_mode),
    })

    let callSid  = null
    let mockMode = false

    try {
      const call = await twilioOutbound.makeOutboundCall({ to: normalizedPhone, sessionId })
      callSid = call.sid
      sessionStore.mapCallSid(callSid, sessionId)
    } catch (err) {
      console.warn('[Priya] Twilio not available — running in mock mode:', err.message)
      callSid  = `mock-${Date.now()}`
      mockMode = true
      sessionStore.update(sessionId, { call_sid: callSid, status: 'calling' })
    }

    // Respond immediately — simulation runs in the background
    res.json({ success: true, session_id: sessionId, call_sid: callSid, mock: mockMode })

    // Fire-and-forget mock conversation so the dashboard has something to show
    if (mockMode) runMockSimulation(sessionId)

  } catch (err) {
    console.error('[Priya] trigger-call error:', err)
    res.status(500).json({ message: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/priya/sessions/:session_id
// ---------------------------------------------------------------------------
router.get('/sessions/:session_id', (req, res) => {
  const session = sessionStore.get(req.params.session_id)
  if (!session) return res.status(404).json({ message: 'Session not found' })

  const isActive = session.status === 'calling' || session.status === 'in-progress'
  const duration = isActive
    ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000)
    : session.duration

  res.json({
    session_id:        session.session_id,
    call_sid:          session.call_sid,
    step:              session.step,
    step_index:        session.step_index,
    collected:         session.collected,
    transcript:        session.transcript,
    duration,
    status:            session.status,
    detected_language: session.detected_language,
  })
})

// ---------------------------------------------------------------------------
// GET /api/priya/calls  — call history (last 50)
// ---------------------------------------------------------------------------
router.get('/calls', (_req, res) => {
  try {
    res.json(sessionStore.getRecentCalls(50))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/priya/calls/:id  — full record for one call (transcript + collected),
// for the call report view.
// ---------------------------------------------------------------------------
router.get('/calls/:id', (req, res) => {
  try {
    const call = sessionStore.getCallById(req.params.id)
    if (!call) return res.status(404).json({ message: 'Call not found' })
    res.json({
      session_id:        call.session_id,
      name:              call.collected?.student_name || call.collected?.parent_name || call.name || 'Unknown',
      phone:             call.phone,
      status:            call.status,
      duration:          call.duration || 0,
      started_at:        call.started_at || call.start_time,
      detected_language: call.detected_language,
      collected:         call.collected || {},
      transcript:        call.transcript || [],
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

module.exports = router
