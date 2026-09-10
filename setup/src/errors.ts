/** Error carrying a user-actionable message (never secrets). */
export class WizardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WizardError'
  }
}
