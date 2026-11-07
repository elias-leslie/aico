import styles from '@/components/BackupsPage.module.css'

/** Recovery's place in the frame. The page itself (what stopped, what came
 * back, one Resume) is recommendation #26; until it lands this says where
 * the same answer lives today. */
export default function RecoveryPage() {
  return (
    <main className={styles.page} data-testid="recovery-page">
      <header>
        <h1>Recovery</h1>
      </header>
      <p>
        Recovery isn’t on the web yet: this page doesn’t know which sessions
        stopped or came back.
      </p>
      <p className={styles.help}>
        On the workstation, <code>tether recovery status</code> lists them.
      </p>
    </main>
  )
}
