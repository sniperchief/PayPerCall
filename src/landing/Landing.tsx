import { Developers } from './Developers'
import { Footer } from './Footer'
import { HeroMain } from './HeroMain'
import { HowItWorks } from './HowItWorks'
import { Trust } from './Trust'

export function Landing() {
  return (
    <>
      <main>
        <HeroMain />
        <HowItWorks />
        <Developers />
        <Trust />
      </main>
      <Footer />
    </>
  )
}
