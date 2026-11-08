#pragma once
#include "../esp_sleep.h"
inline int rtc_gpio_pullup_en(gpio_num_t) { return 0; }
inline int rtc_gpio_pulldown_dis(gpio_num_t) { return 0; }
inline int rtc_gpio_deinit(gpio_num_t) { return 0; }
