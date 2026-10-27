import { useEffect, useState } from 'react'
import { Console } from './components/Console'
import { Header } from './components/Header'
import { Landing } from './landing/Landing'
import { currentView, type View } from './lib/route'

export default function App() {
  const [view, setView] = useState<View>(currentView)
  // The console stays mounted once opened so an in-flight payment keeps its state while the visitor reads the overview.
  const [consoleOpened, setConsoleOpened] = useState(view === 'app')

  useEffect(() => {
    const onHashChange = () => {
      const next = currentView()
      if (next === 'app') setConsoleOpened(true)
      setView(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    // Section anchors reached from the console only exist after the landing page renders.
    const target = view === 'landing' && window.location.hash.length > 1 ? document.getElementById(window.location.hash.slice(1)) : null
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [view])

  return (
    <div className="min-h-dvh">
      <Header view={view} />
      {view === 'landing' && <Landing />}
      {consoleOpened && (
        <div hidden={view !== 'app'}>
          <Console />
        </div>
      )}
    </div>
  )
}
