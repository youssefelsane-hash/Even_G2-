#pragma once
#include <cstddef>
#include <cstdint>
typedef enum { FRAMESIZE_UXGA, FRAMESIZE_QXGA } framesize_t;
typedef enum { PIXFORMAT_JPEG } pixformat_t;
typedef enum { CAMERA_FB_IN_PSRAM } camera_fb_location_t;
typedef enum { CAMERA_GRAB_LATEST } camera_grab_mode_t;
typedef enum { LEDC_CHANNEL_0 } ledc_channel_t;
typedef enum { LEDC_TIMER_0 } ledc_timer_t;
#define ESP_OK 0
#define OV5640_PID 0x5640
#define OV3660_PID 0x3660
typedef struct {
  int pin_pwdn, pin_reset, pin_xclk, pin_sccb_sda, pin_sccb_scl;
  int pin_d7, pin_d6, pin_d5, pin_d4, pin_d3, pin_d2, pin_d1, pin_d0, pin_vsync, pin_href, pin_pclk;
  int xclk_freq_hz;
  ledc_timer_t ledc_timer;
  ledc_channel_t ledc_channel;
  pixformat_t pixel_format;
  framesize_t frame_size;
  int jpeg_quality;
  size_t fb_count;
  camera_fb_location_t fb_location;
  camera_grab_mode_t grab_mode;
} camera_config_t;
typedef struct { uint8_t *buf; size_t len; size_t width; size_t height; } camera_fb_t;
typedef struct { uint16_t PID; } sensor_id_t;
typedef struct sensor_t {
  sensor_id_t id;
  int (*set_sharpness)(struct sensor_t *, int);
  int (*set_contrast)(struct sensor_t *, int);
} sensor_t;
inline int esp_camera_init(const camera_config_t *) { return ESP_OK; }
inline int esp_camera_deinit() { return ESP_OK; }
inline camera_fb_t *esp_camera_fb_get() { return nullptr; }
inline void esp_camera_fb_return(camera_fb_t *) {}
inline sensor_t *esp_camera_sensor_get() { return nullptr; }
