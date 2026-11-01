/**
 * Local question bank for Same Page. 6 categories × 12 questions.
 * A question is identified on the wire by its index in QUESTIONS (`qid`),
 * so the receiver can verify the text really comes from the bank.
 */

export interface Category {
  id: string;
  label: string;
  emoji: string;
}

export const CATEGORIES: readonly Category[] = [
  { id: "know", label: "Get to Know You", emoji: "👋" },
  { id: "fun", label: "Fun & Random", emoji: "🎉" },
  { id: "deep", label: "Deep Conversations", emoji: "🌙" },
  { id: "travel", label: "Travel & Dreams", emoji: "✈️" },
  { id: "people", label: "Relationships & Personality", emoji: "💞" },
  { id: "this", label: "This or That", emoji: "⚖️" },
];

const BANK: Record<string, string[]> = {
  know: [
    "What's something that makes you genuinely happy?",
    "What is one thing people usually misunderstand about you?",
    "Are you more introverted or extroverted?",
    "What's your favourite way to spend a weekend?",
    "What is something you cannot live without?",
    "What's a hobby you could talk about for hours?",
    "What was your favourite subject in school?",
    "What's a small thing that instantly improves your day?",
    "What's the best compliment you've ever received?",
    "Are you a morning person or a night owl?",
    "What's a skill you'd love to learn this year?",
    "What song have you had on repeat lately?",
  ],
  fun: [
    "If you could have one superpower, what would it be?",
    "What's the funniest thing that happened to you recently?",
    "If you could eat one food forever, what would it be?",
    "What's your most unusual habit?",
    "If you could meet any celebrity, who would it be?",
    "If animals could talk, which one would be the funniest?",
    "What would your theme song be when you walk into a room?",
    "If you were a dessert, what would you be?",
    "What's a weird food combination you secretly enjoy?",
    "If you won a free trip to space, would you go?",
    "Which fictional world would you love to live in?",
    "What's a movie you can watch again and again?",
  ],
  deep: [
    "What does happiness mean to you?",
    "What's one lesson life has taught you?",
    "What is something you are proud of?",
    "What motivates you when life gets difficult?",
    "What is one thing you wish more people understood?",
    "What's a belief you've changed your mind about?",
    "Who has influenced you the most, and how?",
    "What does success look like to you?",
    "What's something you're grateful for today?",
    "What advice would you give your younger self?",
    "When do you feel most like yourself?",
    "What's a small act of kindness you still remember?",
  ],
  travel: [
    "Which country would you love to visit?",
    "What is your biggest dream?",
    "Would you rather explore a busy city or a quiet island?",
    "If money were no problem, what would you do?",
    "What is your dream vacation?",
    "What's the most beautiful place you've ever been to?",
    "Long road trip or long train journey?",
    "Which place in your own country do you still want to explore?",
    "What's a dream you've had since you were a child?",
    "If you could live in any city for a year, which would it be?",
    "What's the best meal you've had while travelling?",
    "Where do you see yourself in five years?",
  ],
  people: [
    "What's your biggest green flag in a person?",
    "What makes you trust someone?",
    "What's one quality you value in a friendship?",
    "What does a perfect day with someone look like?",
    "What makes someone interesting to you?",
    "How would your best friend describe you in three words?",
    "Words, time, gifts, help or hugs – how do you show you care?",
    "What's a quality you admire in others but find hard yourself?",
    "How do you usually cheer someone up?",
    "What's something that instantly makes you laugh?",
    "Do you prefer making plans or being spontaneous?",
    "What does being a good listener mean to you?",
  ],
  this: [
    "Mountains or beaches?",
    "Sunrise or sunset?",
    "Coffee or tea?",
    "Calls or texts?",
    "Movies or music?",
    "Cats or dogs?",
    "Books or podcasts?",
    "Sweet or savoury?",
    "Rainy days or sunny days?",
    "Cooking at home or eating out?",
    "Early mornings or late nights?",
    "Window seat or aisle seat?",
  ],
};

export interface BankQuestion {
  qid: number;
  category: string;
  text: string;
}

export const QUESTIONS: readonly BankQuestion[] = CATEGORIES.flatMap((c) => BANK[c.id]).map((text, qid) => ({
  qid,
  text,
  category: CATEGORIES.find((c) => BANK[c.id].includes(text))!.id,
}));

export const CUSTOM_CATEGORY = "custom";

export function categoryOf(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
