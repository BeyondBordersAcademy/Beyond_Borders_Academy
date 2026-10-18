// Placement assessment: 40 questions across grammar, vocabulary, reading,
// listening (real voice audio via public/audio/placement/*.mp3), and
// practical communication.
// Score maps to an approximate CEFR band. The result is ALWAYS labeled an
// estimate, never an official certification.
//
// Listening questions carry an `audio` path (MP3 in public/audio/placement)
// and a `transcript` for the teacher's reference. The transcript is NOT
// rendered to students — the view only shows the audio player.
const QUESTIONS = [
  // --- Grammar (12) ---
  { section: 'Grammar', level: 'A1', qtype: 'multiple_choice', prompt: 'She ___ a teacher.',
    options: ['is', 'are', 'am', 'be'], correct: 'is' },
  { section: 'Grammar', level: 'A1', qtype: 'multiple_choice', prompt: 'They ___ from Colombia.',
    options: ['is', 'are', 'am', 'be'], correct: 'are' },
  { section: 'Grammar', level: 'A1', qtype: 'multiple_choice', prompt: 'My sister ___ ten years old.',
    options: ['is', 'are', 'am', 'be'], correct: 'is' },
  { section: 'Grammar', level: 'A2', qtype: 'multiple_choice', prompt: 'I ___ TV yesterday evening.',
    options: ['watch', 'watched', 'watching', 'watches'], correct: 'watched' },
  { section: 'Grammar', level: 'A2', qtype: 'multiple_choice', prompt: 'She has lived here ___ 2019.',
    options: ['for', 'since', 'from', 'at'], correct: 'since' },
  { section: 'Grammar', level: 'A2', qtype: 'multiple_choice', prompt: 'We ___ to the beach last summer.',
    options: ['go', 'went', 'gone', 'going'], correct: 'went' },
  { section: 'Grammar', level: 'B1', qtype: 'multiple_choice', prompt: 'If it rains tomorrow, we ___ at home.',
    options: ['stay', 'will stay', 'would stay', 'stayed'], correct: 'will stay' },
  { section: 'Grammar', level: 'B1', qtype: 'multiple_choice', prompt: 'The report ___ by the manager yesterday.',
    options: ['wrote', 'was written', 'is written', 'has wrote'], correct: 'was written' },
  { section: 'Grammar', level: 'B1', qtype: 'multiple_choice', prompt: 'She has worked here ___ five years.',
    options: ['for', 'since', 'from', 'at'], correct: 'for' },
  { section: 'Grammar', level: 'B2', qtype: 'multiple_choice', prompt: 'By the time we arrived, the meeting ___.',
    options: ['already started', 'had already started', 'has already started', 'would already start'], correct: 'had already started' },
  { section: 'Grammar', level: 'B2', qtype: 'multiple_choice', prompt: 'I wish I ___ more time to study.',
    options: ['have', 'had', 'will have', 'having'], correct: 'had' },
  { section: 'Grammar', level: 'C1', qtype: 'multiple_choice', prompt: '___ the bad weather, the event was a success.',
    options: ['Despite', 'Although', 'In spite', 'Even'], correct: 'Despite' },
  // --- Vocabulary (8) ---
  { section: 'Vocabulary', level: 'A1', qtype: 'multiple_choice', prompt: 'Choose the correct word: I need to buy some ___ at the store.',
    options: ['bread', 'breads', 'a bread', 'breading'], correct: 'bread' },
  { section: 'Vocabulary', level: 'A2', qtype: 'multiple_choice', prompt: '"Appointment" means:',
    options: ['a type of medicine', 'a scheduled meeting', 'a disappointment', 'a job application'], correct: 'a scheduled meeting' },
  { section: 'Vocabulary', level: 'A2', qtype: 'multiple_choice', prompt: 'A "customer" is someone who:',
    options: ['buys things in a store', 'works in a store', 'owns a store', 'cleans a store'], correct: 'buys things in a store' },
  { section: 'Vocabulary', level: 'B1', qtype: 'multiple_choice', prompt: 'Choose the word closest in meaning to "improve":',
    options: ['worsen', 'enhance', 'ignore', 'delay'], correct: 'enhance' },
  { section: 'Vocabulary', level: 'B1', qtype: 'multiple_choice', prompt: 'Choose the word closest in meaning to "ancient":',
    options: ['very old', 'very new', 'very big', 'very fast'], correct: 'very old' },
  { section: 'Vocabulary', level: 'B2', qtype: 'multiple_choice', prompt: 'The manager asked for a ___ report, with every detail included.',
    options: ['vague', 'comprehensive', 'brief', 'casual'], correct: 'comprehensive' },
  { section: 'Vocabulary', level: 'B2', qtype: 'multiple_choice', prompt: 'If something is "mandatory", it is:',
    options: ['optional', 'required', 'expensive', 'rare'], correct: 'required' },
  { section: 'Vocabulary', level: 'C1', qtype: 'multiple_choice', prompt: '"Meticulous" describes someone who:',
    options: ['works very fast', 'pays great attention to detail', 'talks a lot', 'takes many breaks'], correct: 'pays great attention to detail' },
  // --- Reading (8) ---
  { section: 'Reading', level: 'A1', qtype: 'multiple_choice', prompt: 'Read the sign: "No parking on Mondays." When can you NOT park here?',
    options: ['On Mondays', 'On Tuesdays', 'On weekends', 'Every day'], correct: 'On Mondays' },
  { section: 'Reading', level: 'A2', qtype: 'multiple_choice', prompt: 'Read: "Maria works at a clinic. She starts at 8 a.m. and finishes at 4 p.m." Where does Maria work?',
    options: ['At a school', 'At a clinic', 'At a store', 'At home'], correct: 'At a clinic' },
  { section: 'Reading', level: 'A2', qtype: 'multiple_choice', prompt: 'Read the message: "Hi Ana! Can you bring the red folder to class tomorrow? Thanks, Luis." What should Ana bring?',
    options: ['The red folder', 'A blue pen', 'Her homework', 'Lunch'], correct: 'The red folder' },
  { section: 'Reading', level: 'B1', qtype: 'multiple_choice', prompt: 'Read: "Although the library closes at six, students may return books through the night drop box." What can students do after six?',
    options: ['Enter the library', 'Return books via the drop box', 'Borrow new books', 'Study inside'], correct: 'Return books via the drop box' },
  { section: 'Reading', level: 'B1', qtype: 'multiple_choice', prompt: 'Read: "The new fitness center opens next month. Members can use the pool and gym, but they must bring their own towels." What must members bring?',
    options: ['Their own towels', 'Swimsuits', 'A membership card', 'Nothing'], correct: 'Their own towels' },
  { section: 'Reading', level: 'B2', qtype: 'multiple_choice', prompt: 'Read: "The study suggests that bilingual employees adapt more quickly to new teams, though the effect varies by industry." What does the study suggest?',
    options: ['Bilingual workers earn more', 'Bilingual workers adapt faster to new teams', 'All industries benefit equally', 'Monolingual workers adapt faster'], correct: 'Bilingual workers adapt faster to new teams' },
  { section: 'Reading', level: 'B2', qtype: 'multiple_choice', prompt: 'Read: "Remote work has grown quickly, but a recent survey found that many employees miss face-to-face contact with coworkers — especially younger workers who are still building professional networks." According to the survey, who misses office contact most?',
    options: ['Older workers', 'Younger workers', 'Managers', 'Part-time workers'], correct: 'Younger workers' },
  { section: 'Reading', level: 'C1', qtype: 'multiple_choice', prompt: 'Read: "The author argues that social media has not made us more connected, but rather more performative — we share highlights, not honesty." What is the author\'s main point?',
    options: ['Social media is bad for business', 'Social media encourages showing off, not real connection', 'People should quit social media', 'Highlights are always dishonest'], correct: 'Social media encourages showing off, not real connection' },
  // --- Listening (10) — real voice audio; transcript is for teachers only ---
  { section: 'Listening', level: 'A1', qtype: 'multiple_choice',
    prompt: 'Listen to the conversation, then answer: What does the customer want?',
    audio: '/audio/placement/listen-01.mp3',
    transcript: 'Clerk: "Good morning! How can I help you?" Customer: "Hi. I\'d like to open an account, please."',
    options: ['To close an account', 'To open an account', 'To ask for directions', 'To buy food'], correct: 'To open an account' },
  { section: 'Listening', level: 'A2', qtype: 'multiple_choice',
    prompt: 'Listen to the announcement, then answer: When does the train leave?',
    audio: '/audio/placement/listen-02.mp3',
    transcript: 'Announcement: "Attention, passengers. The train to downtown leaves at 3:15 from platform 2. Please have your tickets ready."',
    options: ['2:15', '3:15', '3:50', '5:15'], correct: '3:15' },
  { section: 'Listening', level: 'B1', qtype: 'multiple_choice',
    prompt: 'Listen to the message, then answer: Will Marco attend the meeting?',
    audio: '/audio/placement/listen-03.mp3',
    transcript: 'Marco: "Hi, it\'s Marco. I was going to attend the meeting, but my shift got extended. I\'ll catch up with you tomorrow."',
    options: ['Yes, definitely', 'No, work got in the way', 'Maybe later', 'The audio was unclear'], correct: 'No, work got in the way' },
  { section: 'Listening', level: 'A1', qtype: 'multiple_choice',
    prompt: 'Listen to the conversation, then answer: What does the customer order to eat?',
    audio: '/audio/placement/listen-04.mp3',
    transcript: 'Waiter: "Good evening! Are you ready to order?" Customer: "Yes. I\'ll have the chicken sandwich, please." Waiter: "Anything to drink?" Customer: "Just water, thanks."',
    options: ['A fish sandwich', 'The chicken sandwich', 'A salad', 'Just water'], correct: 'The chicken sandwich' },
  { section: 'Listening', level: 'A2', qtype: 'multiple_choice',
    prompt: 'Listen to the conversation, then answer: Why can\'t Luis come to the party at seven?',
    audio: '/audio/placement/listen-05.mp3',
    transcript: 'Ana: "Hi Luis! I\'m having a party on Saturday. Do you want to come?" Luis: "I\'d love to, but I work on Saturdays. What time does it start?" Ana: "At seven in the evening." Luis: "Maybe I can come after work!"',
    options: ['He works on Saturdays', 'He is sick', 'He lives too far away', 'He has another party'], correct: 'He works on Saturdays' },
  { section: 'Listening', level: 'B1', qtype: 'multiple_choice',
    prompt: 'Listen to the voicemail, then answer: What time should the patient arrive?',
    audio: '/audio/placement/listen-06.mp3',
    transcript: 'Receptionist: "Hello, this is Dr. Patel\'s office calling to confirm your appointment tomorrow at 10 a.m. Please arrive 15 minutes early and bring your insurance card. Thank you."',
    options: ['At 10:00 a.m.', 'At 9:45 a.m.', 'At 10:15 a.m.', 'At 9:30 a.m.'], correct: 'At 9:45 a.m.' },
  { section: 'Listening', level: 'B1', qtype: 'multiple_choice',
    prompt: 'Listen to the conversation, then answer: What does Carlos need to fix?',
    audio: '/audio/placement/listen-07.mp3',
    transcript: 'Teacher: "Carlos, your essay is good, but you need to check your verb tenses." Carlos: "Should I rewrite the whole thing?" Teacher: "No, just fix the verbs in the second paragraph."',
    options: ['The whole essay', 'The verb tenses in the second paragraph', 'The first paragraph', 'His handwriting'], correct: 'The verb tenses in the second paragraph' },
  { section: 'Listening', level: 'B2', qtype: 'multiple_choice',
    prompt: 'Listen to the conversation, then answer: What is the main problem?',
    audio: '/audio/placement/listen-08.mp3',
    transcript: 'Maria: "Bad news — the client moved the deadline to Friday." James: "That\'s impossible. We still need the designs from Chen, and he never answers his email." Maria: "Then call him. We don\'t have a choice."',
    options: ['They need Chen\'s designs before the Friday deadline', 'The client canceled the project', 'James is on vacation', 'Maria lost the designs'], correct: 'They need Chen\'s designs before the Friday deadline' },
  { section: 'Listening', level: 'B2', qtype: 'multiple_choice',
    prompt: 'Listen to the traffic report, then answer: What should drivers heading downtown do?',
    audio: '/audio/placement/listen-09.mp3',
    transcript: 'Reporter: "And now the traffic. Highway 9 is backed up for three miles due to construction near exit 12. Drivers heading downtown should take Route 4 instead. Expect delays of about 20 minutes."',
    options: ['Take Highway 9', 'Take Route 4', 'Wait 20 minutes on Highway 9', 'Avoid exit 12 only'], correct: 'Take Route 4' },
  { section: 'Listening', level: 'C1', qtype: 'multiple_choice',
    prompt: 'Listen to the conversation, then answer: What is Priya worried about?',
    audio: '/audio/placement/listen-10.mp3',
    transcript: 'Priya: "The quarterly numbers look great, but I\'m uneasy about how we got them." Sam: "You think the sales team cut corners?" Priya: "Let\'s just say I want a full audit before we celebrate."',
    options: ['The sales figures might not be honest', 'The quarter was unprofitable', 'Sam did something wrong', 'The audit will take too long'], correct: 'The sales figures might not be honest' },
  // --- Practical communication (2) ---
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
