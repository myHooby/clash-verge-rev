use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

use crate::enhance::field::use_keys;

const PATCH_CONFIG_INNER: [&str; 5] = ["allow-lan", "ipv6", "log-level", "unified-delay", "tunnels"];

#[derive(Default, Clone)]
pub struct IRuntime {
    pub config: Option<Mapping>,
    // Keys seen in the profile pipeline, including merge and script output.
    pub exists_keys: HashSet<String>,
    // TODO 或许可以用 FixMap 来存储以提升效率
    pub chain_logs: HashMap<String, Vec<(String, String)>>,
}

impl IRuntime {
    #[inline]
    pub fn patch_config(&mut self, patch: &Mapping) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        for key in PATCH_CONFIG_INNER.iter() {
            if let Some(value) = patch.get(key) {
                config.insert((*key).into(), value.clone());
            }
        }

        let Some(patch_tun) = patch.get("tun") else {
            return;
        };

        let tun_key = Value::from("tun");
        if !matches!(config.get(&tun_key), Some(Value::Mapping(_))) {
            config.insert(tun_key.clone(), Value::Mapping(Mapping::new()));
        }

        if let (Some(patch_tun_mapping), Some(Value::Mapping(tun))) = (patch_tun.as_mapping(), config.get_mut(&tun_key))
        {
            for key in use_keys(patch_tun_mapping) {
                if let Some(value) = patch_tun_mapping.get(key.as_str()) {
                    tun.insert(Value::from(key.as_str()), value.clone());
                }
            }
        }
    }

    /// 写入或移除测速专用 listeners。`Some(value)` 覆盖写入，`None` 移除恢复。
    /// 调用方需在注入前自行保存原始 `listeners` 值，以便测速结束后还原。
    #[inline]
    pub fn set_speed_test_listeners(&mut self, listeners: Option<Value>) {
        let Some(config) = self.config.as_mut() else {
            return;
        };

        match listeners {
            Some(value) => {
                config.insert("listeners".into(), value);
            }
            None => {
                config.remove("listeners");
            }
        }
    }

    /// Rebuilds `dialer-proxy` links from an ordered proxy chain, or removes them for `None`.
    #[inline]
    pub fn update_proxy_chain_config(&mut self, proxy_chain_config: Option<Value>) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
            proxies.iter_mut().for_each(|proxy| {
                if let Some(proxy) = proxy.as_mapping_mut()
                    && proxy.get("dialer-proxy").is_some()
                {
                    proxy.remove("dialer-proxy");
                }
            });
        }

        if let Some(Value::Sequence(dialer_proxies)) = proxy_chain_config
            && let Some(Value::Sequence(proxies)) = config.get_mut("proxies")
        {
            for (i, dialer_proxy) in dialer_proxies.iter().enumerate() {
                if let Some(Value::Mapping(proxy)) =
                    proxies.iter_mut().find(|proxy| proxy.get("name") == Some(dialer_proxy))
                    && i != 0
                    && let Some(dialer_proxy) = dialer_proxies.get(i - 1)
                {
                    proxy.insert("dialer-proxy".into(), dialer_proxy.to_owned());
                }
            }
        }
    }
}

/// 为测速构造 listeners 序列：每个节点一个仅监听 127.0.0.1 的 mixed 入站，
/// 通过 `proxy` 字段把该入站的流量绑定到对应节点直接出站（mihomo listeners 能力）。
/// `entries` 为 (节点名, 本地端口) 列表，监听器名按序号生成保证唯一。
pub fn build_speed_test_listeners(entries: &[(&str, u16)]) -> Value {
    let items: Vec<Value> = entries
        .iter()
        .enumerate()
        .map(|(i, (proxy_name, port))| {
            let mut listener = Mapping::new();
            listener.insert("name".into(), Value::from(format!("verge-speed-{i}")));
            listener.insert("type".into(), Value::from("mixed"));
            listener.insert("port".into(), Value::from(u64::from(*port)));
            listener.insert("listen".into(), Value::from("127.0.0.1"));
            listener.insert("udp".into(), Value::from(false));
            listener.insert("proxy".into(), Value::from(*proxy_name));
            Value::Mapping(listener)
        })
        .collect();
    Value::Sequence(items)
}

#[cfg(test)]
mod speed_test_listeners_tests {
    use super::{IRuntime, build_speed_test_listeners};
    use serde_yaml_ng::{Mapping, Value};

    fn sample_runtime_config() -> Mapping {
        let mut config = Mapping::new();
        config.insert("mixed-port".into(), Value::from(7897_u64));
        config.insert("mode".into(), Value::from("rule"));
        config
    }

    #[test]
    fn build_listeners_binds_each_node_on_loopback() {
        let listeners = build_speed_test_listeners(&[("节点 A", 40001), ("proxy-b", 40002)]);
        let Value::Sequence(items) = listeners else {
            panic!("listeners 应为序列");
        };

        assert_eq!(items.len(), 2);
        for (i, item) in items.iter().enumerate() {
            let Value::Mapping(map) = item else {
                panic!("listener 项应为 Mapping");
            };
            assert_eq!(map.get("name"), Some(&Value::from(format!("verge-speed-{i}"))));
            assert_eq!(map.get("type"), Some(&Value::from("mixed")));
            assert_eq!(map.get("listen"), Some(&Value::from("127.0.0.1")));
            assert_eq!(map.get("udp"), Some(&Value::from(false)));
            assert_eq!(map.get("port").and_then(Value::as_u64), Some(40001 + i as u64));
        }
        assert_eq!(items[0].get("proxy"), Some(&Value::from("节点 A")));
        assert_eq!(items[1].get("proxy"), Some(&Value::from("proxy-b")));
    }

    #[test]
    fn set_then_remove_restores_original_state() {
        let mut runtime = IRuntime {
            config: Some(sample_runtime_config()),
            ..IRuntime::default()
        };

        let listeners = build_speed_test_listeners(&[("节点 A", 40001)]);
        runtime.set_speed_test_listeners(Some(listeners.clone()));
        assert_eq!(
            runtime.config.as_ref().and_then(|c| c.get("listeners")),
            Some(&listeners)
        );

        runtime.set_speed_test_listeners(None);
        assert_eq!(runtime.config.as_ref().and_then(|c| c.get("listeners")), None);
        // 其余配置键不受影响
        assert_eq!(
            runtime.config.as_ref().and_then(|c| c.get("mode")),
            Some(&Value::from("rule"))
        );
    }

    #[test]
    fn set_on_missing_config_is_safe() {
        let mut runtime = IRuntime::default();
        runtime.set_speed_test_listeners(Some(build_speed_test_listeners(&[("n", 1)])));
        runtime.set_speed_test_listeners(None);
        assert!(runtime.config.is_none());
    }
}
