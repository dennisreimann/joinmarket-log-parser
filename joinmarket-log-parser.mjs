import { readdir, writeFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

// read directory from argv
const directoryPath = process.argv[2];
const output = process.argv[3] || 'joinmarket.json'

// events
const getInfo = line => {
  if (line.startsWith('Added utxos=')) return { type: 'utxos_added', content: '' }
  else if (line.startsWith('Removed utxos=')) return { type: 'utxos_removed', content: '' }
  else if (line.startsWith('obtained tx')) return { type: 'tx_obtained', content: '' }
  else if (line.startsWith('tx in a block')) return { type: 'tx_confirmed', content: line }
  else if (line.startsWith('potentially earned')) return { type: 'cj_earned', content: line }
  else if (line.startsWith('mycjaddr, mychange')) return { type: 'cj_info', content: line }
}

async function processFile(filePath) {
  const fileStream = createReadStream(filePath)
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

  let entry = null
  const result = []
  for await (const line of rl) {
    const m = line.match(/([\d-:\s]*),\d+\s(?:\[.*?\]\s*)+(.*)/)
    const info = m && getInfo(m[2])
    if (info) {
      const l = result.push({ date: new Date(m[1]), ...info })
      entry = result[l-1]
    } else if (m && info == null) {
      entry = null
    } else if (entry != null) {
      entry.content += `\n${line}`
    }
  }
  return result
}

(async function() {
  // get and process files
  const files = await readdir(directoryPath)
  const promises = files.map(file => processFile(path.join(directoryPath, file)))
  const allResults = await Promise.all(promises)
  // flatten, sort and cleanup
  const results = allResults.flat().sort((a, b) => a.date - b.date).map(entry => {
    let content = entry.content.trim()
    switch (entry.type) {
      case 'tx_obtained':
        if (content.startsWith('[') || content.startsWith('{')) {
          try {
            const json = JSON.parse(content.replace(/'/g, '"'))
            entry = Object.assign(entry, json)
            // unify: convert pre-segwit into new format
            if (entry.ins) {
              entry.inputs = entry.ins.map(i => ({
                outpoint: `${i.outpoint.hash}:${i.outpoint.index}`,
                scriptSig: i.script,
                nSequence: i.sequence,
                witness: null
              }))
              delete entry.ins
            }
            if (entry.outs) {
              entry.outputs = entry.outs.map(o => ({
                value_sats: o.value,
                scriptPubKey: o.script,
                address: null
              }))
              delete entry.outs
            }
            delete entry.content
          } catch(e) {
            console.error(e, content)
          }
        }
        break

      case 'cj_info':
        const cjinfo = content.match(/mycjaddr, mychange = (\w+), (\w+)/)
        if (cjinfo) {
          entry.cjaddr = cjinfo[1]
          entry.change = cjinfo[2]
          delete entry.content
        }
        break

      case 'utxos_added':
      case 'utxos_removed':
          const utxos = content.split('\n').map(utxo => {
            const info = utxo.match(/(\w+):(\d+) - path: (.*), address: (.*), value: (\d+)/)
            return {
              outpoint: `${info[1]}:${info[2]}`,
              path: info[3],
              address: info[4].trim(),
              value: parseInt(info[5])
            }
          })
          entry.utxos = utxos
          delete entry.content
          break

      case 'cj_earned':
        const earned = content.replace('potentially earned = ', '').replace(/.* BTC \(/, '')
        if (earned) {
          entry.sats = parseInt(earned)
          delete entry.content
        }
        break

      case 'tx_confirmed':
        const blockinfo = content.match(/tx in a block: (\w+) with (\d+) confirmations/)
        if (blockinfo) {
          entry.block = blockinfo[1]
          entry.confirmations = parseInt(blockinfo[2])
          delete entry.content
        }
        break

      default:
        entry.content = content
        break
    }
    return entry
  })
  // aggregate by date and join related entries
  const byDate = results.reduce((acc, entry) => {
    let date = entry.date.toISOString()
    switch (entry.type) {
      // find related entry
      case 'utxos_removed':
        const { outpoint } = entry.utxos[0]
        const removeDate = Object.keys(acc).find(key =>
          acc[key].find(e => e.type === 'tx_obtained' &&  e.inputs.find(i => i.outpoint === outpoint)));
        if (removeDate) date = removeDate
        break

      case 'utxos_added':
        const { address } = entry.utxos[0]
        const addDate = Object.keys(acc).find(key =>
          acc[key].find(e => e.type === 'cj_info' && (e.cjaddr === address || e.change === address)));
        if (addDate) date = addDate

      case 'tx_confirmed':
        const blockHash = entry.block
        const confDate = Object.keys(acc).find(key =>
          acc[key].find(e => e.type === 'utxos_added' && (e.utxos.find(u => u.outpoint.startsWith(blockHash)))));
        if (confDate) date = confDate
        break

      default:
        delete entry.date
        break
    }
    if (acc[date] == null) acc[date] = []
    acc[date].push(entry)
    return acc
  }, {})
  // write result
  await writeFile(output, JSON.stringify(byDate, null, 2))
})()
