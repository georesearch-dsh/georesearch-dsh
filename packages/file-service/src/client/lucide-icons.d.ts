declare module 'lucide-react/dist/esm/icons/*.js' {
  import type { ComponentType, SVGProps } from 'react'

  const Icon: ComponentType<SVGProps<SVGSVGElement> & {
    readonly size?: number | string
    readonly strokeWidth?: number | string
  }>
  export default Icon
}
