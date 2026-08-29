import { CheckCircleOutlineRounded } from '@mui/icons-material'
import {
  alpha,
  Box,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
  type SxProps,
  type Theme,
} from '@mui/material'
import { useTranslation } from 'react-i18next'

import { BaseLoading } from '@/components/base'
import { useProxyDelayState } from '@/hooks/use-proxy-delay-state'
import { useSpeedState } from '@/hooks/use-speed-state'
import delayManager from '@/services/delay'
import speedManager, { getStoredSpeedTestOptions } from '@/services/speed'
import {
  memberDetails,
  type ProxyGroupView,
  type ResolvedProxyMember,
} from '@/types/proxy-view'
import { classifySpeed, formatSpeed, speedColor } from '@/utils/speed'

interface Props {
  group: ProxyGroupView
  member: ResolvedProxyMember
  selected: boolean
  showType?: boolean
  sx?: SxProps<Theme>
  onClick?: (member: ResolvedProxyMember) => void
}

const Widget = styled(Box)(() => ({
  padding: '3px 6px',
  fontSize: 14,
  borderRadius: '4px',
}))

const TypeBox = styled('span')(({ theme }) => ({
  display: 'inline-block',
  border: '1px solid #ccc',
  borderColor: alpha(theme.palette.text.secondary, 0.36),
  color: alpha(theme.palette.text.secondary, 0.42),
  borderRadius: 4,
  fontSize: 10,
  marginRight: '4px',
  padding: '0 2px',
  lineHeight: 1.25,
}))

export const ProxyItem = (props: Props) => {
  const { t } = useTranslation()
  const { group, member, selected, showType = true, sx, onClick } = props
  const details = memberDetails(member)
  const unresolved = member.kind === 'unresolved'
  const name = member.ref.name
  const type = unresolved ? member.ref.reason : (details?.type ?? '')
  const now = member.kind === 'group' ? member.group.now : undefined

  // -1/<=0 为不显示，-2 为 loading
  const { delayValue, isPreset, timeout, onDelay } = useProxyDelayState(
    member,
    group.name,
  )

  // 节点速度徽章：点击可单节点重测（测速运行中不重复发起）
  const speedUpdate = useSpeedState(name)
  const onSpeedRetest = async () => {
    if (speedManager.getRunStatus().running) return
    const { concurrency, url } = getStoredSpeedTestOptions()
    try {
      await speedManager.startTest(group.name, [name], concurrency, url)
    } catch {
      // 忙等异常通过徽章状态自可见，无需弹窗
    }
  }

  return (
    <ListItem sx={sx}>
      <ListItemButton
        dense
        disabled={unresolved}
        selected={!unresolved && selected}
        onClick={unresolved ? undefined : () => onClick?.(member)}
        sx={[
          { borderRadius: 1 },
          ({ palette: { mode, primary } }) => {
            const bgcolor = mode === 'light' ? '#ffffff' : '#24252f'
            const selectColor = mode === 'light' ? primary.main : primary.light
            const showDelay = delayValue > 0

            return {
              '&:hover .the-check': { display: !showDelay ? 'block' : 'none' },
              '&:hover .the-delay': { display: showDelay ? 'block' : 'none' },
              '&:hover .the-icon': { display: 'none' },
              '&.Mui-selected': {
                width: `calc(100% + 3px)`,
                marginLeft: `-3px`,
                borderLeft: `3px solid ${selectColor}`,
                bgcolor:
                  mode === 'light'
                    ? alpha(primary.main, 0.15)
                    : alpha(primary.main, 0.35),
              },
              backgroundColor: bgcolor,
              marginBottom: '8px',
              height: '40px',
            }
          },
        ]}
      >
        <ListItemText
          title={name}
          secondary={
            <>
              <Box
                sx={{
                  display: 'inline-block',
                  marginRight: '8px',
                  fontSize: '14px',
                  color: 'text.primary',
                }}
              >
                {name}
                {showType && now && ` - ${now}`}
              </Box>
              {showType && <TypeBox>{type}</TypeBox>}
              {!unresolved && showType && details?.udp && (
                <TypeBox>UDP</TypeBox>
              )}
              {!unresolved && showType && details?.xudp && (
                <TypeBox>XUDP</TypeBox>
              )}
              {!unresolved && showType && details?.tfo && (
                <TypeBox>TFO</TypeBox>
              )}
              {!unresolved && showType && details?.mptcp && (
                <TypeBox>MPTCP</TypeBox>
              )}
              {!unresolved && showType && details?.smux && (
                <TypeBox>SMUX</TypeBox>
              )}
            </>
          }
        />

        <ListItemIcon
          sx={{
            justifyContent: 'flex-end',
            color: 'primary.main',
            display: isPreset ? 'none' : '',
          }}
        >
          {!unresolved && delayValue === -2 && (
            <Widget>
              <BaseLoading />
            </Widget>
          )}

          {!unresolved && delayValue !== -2 && (
            <Widget
              className="the-check"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void onDelay()
              }}
              sx={({ palette }) => ({
                display: 'none', // hover 时显示
                ':hover': { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              {t('shared.actions.check')}
            </Widget>
          )}

          {!unresolved && delayValue > 0 && (
            // 显示延迟
            <Widget
              className="the-delay"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void onDelay()
              }}
              sx={({ palette }) => ({
                color: delayManager.formatDelayColor(delayValue, timeout),
                ':hover': { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              {delayManager.formatDelay(delayValue, timeout)}
            </Widget>
          )}

          {!unresolved && speedUpdate?.state === 'testing' && (
            <Widget sx={{ fontSize: 12, ml: 0.5 }}>
              <BaseLoading />
            </Widget>
          )}

          {!unresolved && speedUpdate && speedUpdate.state !== 'testing' && (
            <Widget
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void onSpeedRetest()
              }}
              title={speedUpdate.error ?? name}
              sx={({ palette }) => ({
                ml: 0.5,
                fontSize: 12,
                cursor: 'pointer',
                color: speedColor(classifySpeed(speedUpdate)),
                ':hover': { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              {speedUpdate.state === 'ok'
                ? formatSpeed(speedUpdate.speedBps)
                : 'Error'}
            </Widget>
          )}

          {!unresolved && delayValue !== -2 && delayValue <= 0 && selected && (
            // 展示已选择的 icon
            <CheckCircleOutlineRounded
              className="the-icon"
              sx={{ fontSize: 16 }}
            />
          )}
        </ListItemIcon>
      </ListItemButton>
    </ListItem>
  )
}
