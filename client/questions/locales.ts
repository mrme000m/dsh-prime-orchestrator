/** Locale bundle for the pending-questions banner. */

/** Locale keys the banner renders. */
export type PrimeQuestionsKey =
  | 'bannerTitle'
  | 'open'
  | 'answer'
  | 'back'
  | 'submit'
  | 'submitting'
  | 'cancelQuestion'
  | 'autoIn'
  | 'noAuto'
  | 'recommended'
  | 'customPlaceholder'
  | 'skip'
  | 'errorText'
  | 'questionCount'

/** English copy. */
export const en: Record<PrimeQuestionsKey, string> = {
  bannerTitle: 'A conversation is waiting for your answer',
  open: 'Open conversation',
  answer: 'Answer here',
  back: 'Back',
  submit: 'Submit answers',
  submitting: 'Submitting…',
  cancelQuestion: 'Dismiss question',
  autoIn: 'auto-answers in {time}',
  noAuto: 'no auto-answer',
  recommended: 'Recommended',
  customPlaceholder: 'Type your answer',
  skip: 'Skip this question',
  errorText: 'Could not send the answer.',
  questionCount: '{n} question(s)',
}

/** Simplified Chinese copy. */
export const zh: Record<PrimeQuestionsKey, string> = {
  bannerTitle: '有会话正在等待你的回答',
  open: '打开会话',
  answer: '在此作答',
  back: '返回',
  submit: '提交答案',
  submitting: '正在提交…',
  cancelQuestion: '取消该问题',
  autoIn: '{time} 后自动作答',
  noAuto: '不会自动作答',
  recommended: '推荐',
  customPlaceholder: '输入你的答案',
  skip: '跳过本题',
  errorText: '答案发送失败。',
  questionCount: '{n} 道问题',
}
