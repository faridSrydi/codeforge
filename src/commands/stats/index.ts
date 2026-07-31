import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: 'Show yourCode Forge usage statistics and activity',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
