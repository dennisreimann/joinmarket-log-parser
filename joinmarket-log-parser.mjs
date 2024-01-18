import { readdir, writeFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

// read directory from argv
const directoryPath = process.argv[2]

// events
const getInfo = line => {
  if (line.startsWith('Added utxos=')) return { type: 'utxos_added', content: '' }
  else if (line.startsWith('Removed utxos=')) return { type: 'utxos_removed', content: '' }
  else if (line.startsWith('chosen orders =')) return { type: 'chosen_orders', content: '' }
  else if (line.startsWith('cj amount =')) return { type: 'cj_amount', content: line }
  else if (line.startsWith('total cj fee =')) return { type: 'cj_fee', content: line }
  else if (line.startsWith('total coinjoin fee =')) return { type: 'cj_fee', content: line }
  else if (line.startsWith('obtained tx')) return { type: 'tx_obtained', content: '' }
  else if (line.startsWith('txid = ')) return { type: 'tx_send', content: line }
  else if (line.startsWith('schedule item was: ')) return { type: 'schedule_item', content: line }
  else if (line.startsWith('filling offer')) return { type: 'filling_offer', content: line }
  else if (line.startsWith('sending output to address=')) return { type: 'sending_output', content: line }
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
      entry.file = path.basename(filePath)
    } else if (m && info == null) {
      entry = null
    } else if (entry != null) {
      entry.content += `\n${line}`
    }
  }
  return result
}

;(async function() {
  // get and process files
  const files = await readdir(directoryPath)
  const promises = files.map(file => processFile(path.join(directoryPath, file)))
  const allResults = await Promise.all(promises)
  // flatten, sort and cleanup
  const results = allResults.flat().sort((a, b) => a.date - b.date).map(entry => {
    let content = entry.content.trim()
    switch (entry.type) {
      case 'chosen_orders':
        entry.orders = JSON.parse(`[${content.replace(/'/g, '"').replace(/[\s\S]\{/g, ',{')}]`)
        delete entry.content
        break

      case 'cj_amount':
        const amt = content.match(/cj amount = (\w+)/)
        if (amt) {
          entry.amount_sats = parseInt(amt[1])
          delete entry.content
        }
        break

      case 'cj_fee':
        const fee = content.match(/ = (.*)/)
        if (fee) {
          if (fee[1].endsWith('%'))
            entry.fee_percent = fee[1]
          else
            entry.fee_sats = parseInt(fee[1])
          delete entry.content
        }
        break

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

      case 'tx_send':
        const info = content.match(/txid = (\w+)/)
        if (info) {
          entry.txid = info[1]
          delete entry.content
        }
        break

      case 'filling_offer':
        const offer = content.match(/filling offer, mixdepth=(\d+), amount=(\d+)/)
        if (offer) {
          entry.mixdepth = parseInt(offer[1])
          entry.amount_sats = parseInt(offer[2])
          delete entry.content
        }
        break

      case 'sending_output':
        const output = content.match(/sending output to address=(\w+)/)
        if (output) {
          entry.to_address = output[1]
          delete entry.content
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

      case 'schedule_item':
        const schedule = content.match(/schedule item was: (\[.*\])/)
        if (schedule) {
          const [mixdepth, amount, counterparties, to_address] = JSON.parse(schedule[1].replace(/'/g, '"'))
          entry.mixdepth = mixdepth
          entry.amount_sats = amount
          entry.counterparties = counterparties
          entry.to_address = to_address
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
  let prev = null
  const byDate = results.reduce((acc, entry) => {
    let date = entry.date.toISOString()
    switch (entry.type) {
      // find related entry
      case 'utxos_removed':
        const { outpoint } = entry.utxos[0]
        const removeDate = Object.keys(acc).find(key =>
          acc[key].find(e => e.type === 'tx_obtained' &&  e.inputs.find(i => i.outpoint === outpoint)) &&
          !acc[key].find(e => e.type === 'utxos_removed'))
        if (removeDate) date = removeDate
        break

      case 'utxos_added':
        const { address } = entry.utxos[0]
        const addDate = Object.keys(acc).find(key =>
          acc[key].find(e => e.type === 'cj_info' && (e.cjaddr === address || e.change === address)) &&
          !acc[key].find(e => e.type === 'utxos_added'))
        if (addDate) date = addDate

      case 'tx_confirmed':
        const blockHash = entry.block
        const confDate = Object.keys(acc).find(key =>
          acc[key].find(e => e.type === 'utxos_added' && (e.utxos.find(u => u.outpoint.startsWith(blockHash)))) &&
          !acc[key].find(e => e.type === 'tx_confirmed'))
        if (confDate) date = confDate
        break

      case 'sending_output':
        if (prev.type == 'filling_offer') {
          entry.date = prev.date
          date = entry.date.toISOString()
        }
        break

      case 'tx_obtained':
        if (['sending_output', 'filling_offer', 'cj_fee', 'cj_amount', 'chosen_orders'].includes(prev.type)) {
          entry.date = prev.date
          date = entry.date.toISOString()
        }
        break

      case 'cj_earned':
        if (['utxos_removed', 'tx_obtained'].includes(prev.type)) {
          entry.date = prev.date
          date = entry.date.toISOString()
        }
        break

      case 'cj_info':
        if (['cj_earned', 'tx_obtained'].includes(prev.type)) {
          entry.date = prev.date
          date = entry.date.toISOString()
        }
        break

      case 'schedule_item':
        if (['utxos_removed', 'tx_obtained'].includes(prev.type)) {
          entry.date = prev.date
          date = entry.date.toISOString()
        }
        break

      case 'tx_send':
        if (['schedule_item'].includes(prev.type)) {
          entry.date = prev.date
          date = entry.date.toISOString()
        }
        break
    }
    if (acc[date] == null) acc[date] = []
    acc[date].push(entry)
    prev = entry
    return acc
  }, {})
  // write result
  await writeFile('joinmarket.json', JSON.stringify(byDate, null, 2))

  // BIP 329 labels
  // { "type": "tx", "ref": "52a8a8317c8836ad11e0a3402196db97bdac51566739b8a2d4dff526edb7fd5d", "label": "cj" }
  // { "type": "addr", "ref": "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c", "label": "Address" }
  // { "type": "input", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:0", "label": "Input" }
  // { "type": "output", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:1", "label": "Output" , "spendable" : "false" }

  const bip329 = Object.values(byDate).reduce((acc, entries) => {
    const fillingOffer = entries.find(entry => entry.type === 'filling_offer')
    const sendingOutput = entries.find(entry => entry.type === 'sending_output')
    const chosenOrders = entries.find(entry => entry.type === 'chosen_orders')
    const txSend = entries.find(entry => entry.type === 'tx_send')
    const scheduleItem = entries.find(entry => entry.type === 'schedule_item')
    const utxosAdded = entries.find(entry => entry.type === 'utxos_added')
    const utxosRemoved = entries.find(entry => entry.type === 'utxos_removed')
    const cjInfo = entries.find(entry => entry.type === 'cj_info')

    const fundingLabel = 'Funding'
    let cjLabel = ''
    if (fillingOffer && utxosAdded) {
      cjLabel = `Mixdepth ${fillingOffer.mixdepth} Maker`
      acc.push({ type: 'tx', ref: utxosAdded.utxos[0].outpoint.split(':')[0], label: cjLabel })
    } else if (utxosRemoved && txSend) {
      const md = scheduleItem && scheduleItem.mixdepth
      cjLabel = `Mixdepth${md ? ` ${md}` : ''} Taker`
      acc.push({ type: 'tx', ref: txSend.txid, label: cjLabel })
    }
    if (cjInfo) {
      acc.push({ type: 'addr', ref: cjInfo.cjaddr, label: (cjLabel + ' Coinjoined').trim() })
      acc.push({ type: 'addr', ref: cjInfo.change, label: (cjLabel + ' Change').trim() })
    }
    if (utxosAdded) {
      if (cjInfo) {
        utxosAdded.utxos.forEach(utxo => {
          acc.push({ type: 'output', ref: utxo.outpoint, label: utxo.address === cjInfo.cjaddr ? (cjLabel + ' Coinjoined').trim() : (cjLabel + ' Change').trim() })
        })
      } else {
        utxosAdded.utxos.forEach(utxo => {
          acc.push({ type: 'output', ref: utxo.outpoint, label: fundingLabel })
        })
      }
    }
    if (utxosRemoved) {
      if (cjInfo) {
        utxosRemoved.utxos.forEach(utxo => {
          const prevOutput = acc.find(e => e.type === 'output' &&  e.ref === utxo.outpoint && e.label != fundingLabel)
          const thisLabel = (cjLabel + ' Coinjoined').trim()
          const label = prevOutput ? [prevOutput.label, thisLabel].join(', ') : thisLabel
          acc.push({ type: 'input', ref: utxo.outpoint, label })
        })
      } else {
        utxosRemoved.utxos.forEach(utxo => {
          const prevOutput = acc.find(e => e.type === 'output' &&  e.ref === utxo.outpoint && e.label != fundingLabel)
          const thisLabel = 'Withdrawal'
          const label = prevOutput ? [prevOutput.label, thisLabel].join(', ') : thisLabel
          acc.push({ type: 'input', ref: utxo.outpoint, label })
        })
      }
    }
    return acc
  }, []).map(JSON.stringify).join('\n')
  await writeFile('joinmarket-bip329.json', bip329)
})()
