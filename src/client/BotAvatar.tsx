export const botShapes = ['Circle', 'Cloud', 'Square', 'Sparkle', 'Flower', 'Heart', 'Clover', 'Droplet', 'Capsule', 'Triangle', 'Pebble', 'Star', 'Hexagon', 'Pumpkin'] as const
export type BotShape = typeof botShapes[number]
export type BotAppearance = { shape: BotShape; color: string }

const shapePaths: Record<Exclude<BotShape, 'Circle'>, string> = {
  Cloud: 'M22 29C14 17 32 10 43 16C57 6 75 17 74 29C91 34 91 53 81 61C85 78 66 88 54 82C39 94 19 83 21 70C4 62 8 39 22 29Z',
  Square: 'M23 14H77Q86 14 86 23V77Q86 86 77 86H23Q14 86 14 77V23Q14 14 23 14Z',
  Sparkle: 'M50 5C61 5 62 30 68 33C75 38 95 40 95 50C95 60 74 64 68 68C62 74 61 95 50 95C39 95 38 73 32 68C26 63 5 61 5 50C5 39 26 37 32 32C38 26 39 5 50 5Z',
  Flower: 'M50 17C68 1 86 14 80 32C102 36 99 60 82 65C87 86 64 98 51 82C37 100 13 87 19 67C0 59 1 36 21 31C15 13 37 0 50 17Z',
  Heart: 'M50 24C28 0 2 18 7 43C10 59 32 80 44 90Q50 96 56 90C68 80 90 59 93 43C98 18 72 0 50 24Z',
  Clover: 'M50 17C68 0 90 17 77 36C103 43 95 74 73 72C72 98 42 101 35 78C13 90 -1 62 20 48C1 32 20 8 40 22Z',
  Droplet: 'M48 7C39 15 17 38 16 58C14 99 84 104 85 62C85 39 59 12 48 7Z',
  Capsule: 'M33 21H67C105 21 105 79 67 79H33C-5 79 -5 21 33 21Z',
  Triangle: 'M39 13Q49 4 59 15L91 65Q101 84 80 86H20Q0 85 10 65Z',
  Pebble: 'M30 10Q39 4 49 13L79 33Q87 39 87 49L84 79Q83 88 72 88H26Q13 88 13 76L12 42Q12 33 19 24Z',
  Star: 'M50 6Q56 3 60 14L67 32L87 32Q100 32 91 44L76 58L83 79Q87 93 74 86L50 73L29 87Q16 95 20 79L26 58L9 44Q0 33 14 32L34 31L41 12Q45 3 50 6Z',
  Hexagon: 'M31 10Q26 10 22 17L5 44Q1 50 5 57L22 84Q26 91 33 91H68Q75 91 79 84L95 57Q99 50 95 44L78 17Q74 10 67 10Z',
  Pumpkin: 'M50 19C73 8 98 27 91 58C89 81 68 94 51 87C32 97 9 80 8 58C2 32 25 11 50 19Z',
}

export function BotAvatar({ appearance, variant = 'cfo', className = '' }: { appearance?: BotAppearance; variant?: 'cfo' | 'yui'; className?: string }) {
  if (!appearance) return <span aria-hidden="true" className={`avatar avatar--${variant} ${className}`}><span className="avatar-eye" /><span className="avatar-eye" /></span>
  return <span aria-hidden="true" className={`avatar avatar--custom ${className}`} data-shape={appearance.shape} data-color={appearance.color}>
    <svg viewBox="0 0 100 100" fill="none">
      <g transform="rotate(-17 50 50)">
        {appearance.shape === 'Pumpkin' && <path d="M51 23Q43 7 51 5Q61 12 58 23Z" fill="#686b5e" />}
        {appearance.shape === 'Circle' ? <circle cx="50" cy="50" r="42" fill={appearance.color} /> : <path d={shapePaths[appearance.shape]} fill={appearance.color} />}
        <rect x="35" y="42" width="9" height="20" rx="4.5" fill="#202020" />
        <rect x="57" y="42" width="9" height="20" rx="4.5" fill="#202020" />
      </g>
    </svg>
  </span>
}
