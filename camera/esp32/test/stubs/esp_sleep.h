#pragma once
typedef enum { GPIO_NUM_2 = 2 } gpio_num_t;
typedef enum { ESP_SLEEP_WAKEUP_UNDEFINED, ESP_SLEEP_WAKEUP_EXT0 } esp_sleep_wakeup_cause_t;
inline esp_sleep_wakeup_cause_t esp_sleep_get_wakeup_cause() { return ESP_SLEEP_WAKEUP_UNDEFINED; }
inline int esp_sleep_enable_ext0_wakeup(gpio_num_t, int) { return 0; }
inline void esp_deep_sleep_start() {}
