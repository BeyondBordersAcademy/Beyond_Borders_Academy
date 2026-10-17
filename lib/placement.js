// Placement assessment: ~20 questions across grammar, vocabulary, reading,
// and listening (listening uses short written dialogues in Phase 1 --
// clearly labeled). Score maps to an approximate CEFR band. The result is
// ALWAYS labeled an estimate, never an official certification.
const QUESTIONS = [
  // --- Grammar (A1-A2) ---
  { section: 'Grammar', level: 'A1', qtype: 'multiple_choice', prompt: 'She ___ a teacher.',
    options: ['is', 'are', 'am', 'be'], correct: 'is' },
  { section: 'Grammar', level: 'A1', qtype: 'multiple_choice', prompt: 'They ___ from Colombia.',
    options: ['is', 'are', 'am', 'be'], correct: 'are' },
  { section: 'Grammar', level: 'A2', qtype: 'multiple_choice', prompt: 'I ___ TV yesterday evening.',
    options: ['watch', 'watched', 'watching', 'watches'], correct: 'watched' },
  { section: 'Grammar', level: 'A2', qtype: 'multiple_choice', prompt: 'She has lived here ___ 2019.',
    options: ['for', 'since', 'from', 'at'], correct: 'since' },
  { section: 'Grammar', level: 'B1', qtype: 'multiple_choice', prompt: 'If it rains tomorrow, we ___ at home.',
    options: ['stay', 'will stay', 'would stay', 'stayed'], correct: 'will stay' },
  { section: 'Grammar', level: 'B1', qtype: 'multiple_choice', prompt: 'The report ___ by the manager yesterday.',
    options: ['wrote', 'was written', 'is written', 'has wrote'], correct: 'was written' },
  { section: 'Grammar', level: 'B2', qtype: 'multiple_choice', prompt: 'By the time we arrived, the meeting ___.',
    options: ['already started', 'had already started', 'has already started', 'would already start'], correct: 'had already started' },
  { section: 'Grammar', level: 'C1', qtype: 'multiple_choice', prompt: '___ the bad weather, the event was a success.',
    options: ['Despite', 'Although', 'In spite', 'Even'], correct: 'Despite' },
  // --- Vocabulary ---
  { section: 'Vocabulary', level: 'A1', qtype: 'multiple_choice', prompt: 'Choose the correct word: I need to buy some ___ at the store.',
    options: ['bread', 'breads', 'a bread', 'breading'], correct: 'bread' },
  { section: 'Vocabulary', level: 'A2', qtype: 'multiple_choice', prompt: '"Appointment" means:',
    options: ['a type of medicine', 'a scheduled meeting', 'a disappointment', 'a job application'], correct: 'a scheduled meeting' },
  { section: 'Vocabulary', level: 'B1', qtype: 'multiple_choice', prompt: 'Choose the word closest in meaning to "improve":',
    options: ['worsen', 'enhance', 'ignore', 'delay'], correct: 'enhance' },
  { section: 'Vocabulary', level: 'B2', qtype: 'multiple_choice', prompt: 'The manager asked for a ___ report, with every detail included.',
    options: ['vague', 'comprehensive', 'brief', 'casual'], correct: 'comprehensive' },
  // --- Reading ---
  { section: 'Reading', level: 'A2', qtype: 'multiple_choice', prompt: 'Read: "Maria works at a clinic. She starts at 8 a.m. and finishes at 4 p.m." Where does Maria work?',
    options: ['At a school', 'At a clinic', 'At a store', 'At home'], correct: 'At a clinic' },
  { section: 'Reading', level: 'B1', qtype: 'multiple_choice', prompt: 'Read: "Although the library closes at six, students may return books through the night drop box." What can students do after six?',
    options: ['Enter the library', 'Return books via the drop box', 'Borrow new books', 'Study inside'], correct: 'Return books via the drop box' },
  { section: 'Reading', level: 'B2', qtype: 'multiple_choice', prompt: 'Read: "The study suggests that bilingual employees adapt more quickly to new teams, though the effect varies by industry." What does the study suggest?',
    options: ['Bilingual workers earn more', 'Bilingual workers adapt faster to new teams', 'All industries benefit equally', 'Monolingual workers adapt faster'], correct: 'Bilingual workers adapt faster to new teams' },
  // --- Listening (written dialogues in Phase 1) ---
  { section: 'Listening', level: 'A1', qtype: 'multiple_choice', prompt: 'Listen/Read — Clerk: "How can I help you?" Customer: "I\'d like to open an account." What does the customer want?',
    options: ['To close an account', 'To open an account', 'To ask for directions', 'To buy food'], correct: 'To open an account' },
  { section: 'Listening', level: 'A2', qtype: 'multiple_choice', prompt: 'Listen/Read — "The train to downtown leaves at 3:15 from platform 2." When does the train leave?',
    options: ['2:15', '3:15', '3:50', '5:15'], correct: '3:15' },
  { section: 'Listening', level: 'B1', qtype: 'multiple_choice', prompt: 'Listen/Read — Speaker: "I was going to attend, but my shift got extended." Will the speaker attend?',
    options: ['Yes, definitely', 'No, work got in the way', 'Maybe later', 'The audio was unclear'], correct: 'No, work got in the way' },
  // --- Practical communication ---
  { section: 'Communication', level: 'A2', qtype: 'multiple_choice', prompt: 'Your coworker says "Could you give me a hand?" They want you to:',
    options: ['Shake their hand', 'Help them', 'Show your hand', 'Leave'], correct: 'Help them' },
  { section: 'Communication', level: 'B1', qtype: 'multiple_choice', prompt: 'Which is the most polite way to make a request?',
    options: ['"Give me the report."', '"I want the report now."', '"Could you please send me the report?"', '"You must send the report."'], correct: '"Could you please send me the report?"' },
];

const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// Score -> approximate CEFR band (labeled an estimate, not certification).
function estimateCEFR(correctCount, total) {
  const pct = total ? (correctCount / total) * 100 : 0;
  if (pct < 20) return 'A1';
  if (pct < 40) return 'A2';
  if (pct < 55) return 'B1';
  if (pct < 70) return 'B2';
  if (pct < 85) return 'C1';
  return 'C2';
}

const LEVEL_DESCRIPTIONS = {
  A1: 'Beginner: you can understand and use everyday expressions and very basic phrases.',
  A2: 'Elementary: you can communicate in simple, routine tasks and describe your background in simple terms.',
  B1: 'Intermediate: you can handle most travel situations and describe experiences, hopes, and plans.',
  B2: 'Upper-Intermediate: you can interact with fluency and understand the main ideas of complex text.',
  C1: 'Advanced: you can use English flexibly for academic and professional purposes.',
  C2: 'Proficiency: you can understand virtually everything and express yourself with precision.',
};

module.exports = { QUESTIONS, CEFR_ORDER, estimateCEFR, LEVEL_DESCRIPTIONS };
