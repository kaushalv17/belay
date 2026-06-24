import { BODY_HTML } from './_data/bodyHtml'
import LandingScripts from './LandingScripts'

export default function Page() {
  const markup = { __html: BODY_HTML }
  return (
    <>
      <div dangerouslySetInnerHTML={markup} />
      <LandingScripts />
    </>
  )
}
