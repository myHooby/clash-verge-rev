import delayManager from '@/services/delay'
import speedManager from '@/services/speed'
import { memberDetails } from '@/types/proxy-view'
import { compareByDelay, DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'
import { compileStringMatcher } from '@/utils/search-matcher'
import { compareBySpeed } from '@/utils/speed'

import type { ResolvedMemberOccurrence } from './use-render-list'

/** 0 默认 / 1 按延迟 / 2 按名称 / 3 按网速 */
export type ProxySortType = 0 | 1 | 2 | 3

export type ProxySearchState = {
  matchCase?: boolean
  matchWholeWord?: boolean
  useRegularExpression?: boolean
}

export function filterSort(
  proxies: ResolvedMemberOccurrence[],
  groupName: string,
  filterText: string,
  sortType: ProxySortType,
  latencyTimeout?: number,
  searchState?: ProxySearchState,
) {
  const fp = filterProxies(proxies, groupName, filterText, searchState)
  const sp = sortProxies(fp, groupName, sortType, latencyTimeout)
  return sp
}

const regex1 = /delay([=<>])(\d+|timeout|error)/i
const regex2 = /type=(.*)/i

function filterProxies(
  proxies: ResolvedMemberOccurrence[],
  groupName: string,
  filterText: string,
  searchState?: ProxySearchState,
) {
  const query = filterText.trim()
  if (!query) return proxies

  const res1 = regex1.exec(query)
  if (res1) {
    const symbol = res1[1]
    const symbol2 = res1[2].toLowerCase()
    const value =
      symbol2 === 'error' ? 1e5 : symbol2 === 'timeout' ? 3000 : +symbol2

    return proxies.filter(({ member }) => {
      const delay = delayManager.getDelayFix(member, groupName)

      if (delay < 0) return false
      if (symbol === '=' && symbol2 === 'error') return delay >= 1e5
      if (symbol === '=' && symbol2 === 'timeout')
        return delay < 1e5 && delay >= 3000
      if (symbol === '=') return delay == value
      if (symbol === '<') return delay <= value
      if (symbol === '>') return delay >= value
      return false
    })
  }

  const res2 = regex2.exec(query)
  if (res2) {
    const type = res2[1].toLowerCase()
    return proxies.filter(({ member }) =>
      (memberDetails(member)?.type ?? '').toLowerCase().includes(type),
    )
  }

  const {
    matchCase = false,
    matchWholeWord = false,
    useRegularExpression = false,
  } = searchState ?? {}
  const compiled = compileStringMatcher(query, {
    matchCase,
    matchWholeWord,
    useRegularExpression,
  })

  if (!compiled.isValid) return []
  return proxies.filter(({ member }) => compiled.matcher(member.ref.name))
}

function sortProxies(
  proxies: ResolvedMemberOccurrence[],
  groupName: string,
  sortType: ProxySortType,
  latencyTimeout?: number,
) {
  if (!proxies) return []
  if (sortType === 0) return proxies

  const effectiveTimeout =
    typeof latencyTimeout === 'number' && latencyTimeout > 0
      ? latencyTimeout
      : DEFAULT_DELAY_TIMEOUT

  if (sortType === 1 && proxies.length > 1) {
    return proxies
      .map((proxy) => ({
        proxy,
        delay: delayManager.getDelayFix(proxy.member, groupName),
      }))
      .sort((a, b) => compareByDelay(a.delay, b.delay, effectiveTimeout))
      .map(({ proxy }) => proxy)
  }
  if (sortType === 3) {
    // 按网速：实测降序，失败/测试中/未测依次靠后；预取测速结果避免比较器内重复查询
    return proxies
      .map((proxy) => ({
        proxy,
        update: speedManager.getSpeedUpdate(proxy.member.ref.name),
      }))
      .sort((a, b) => compareBySpeed(a.update, b.update))
      .map(({ proxy }) => proxy)
  }
  const list = proxies.slice()
  if (sortType !== 1) {
    list.sort((a, b) => a.member.ref.name.localeCompare(b.member.ref.name))
  }

  return list
}
