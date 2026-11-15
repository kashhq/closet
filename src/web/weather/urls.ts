/**
 * The weather settings' page (#14; its own page under Profile since #728),
 * where the home city, the unit and the offset are set. It exists only
 * with WEATHER_ENABLED, like every weather route. Profile's row keeps the
 * section's id, so `/auth/profile#weather` lands on the row opening it.
 */
export const WEATHER_SETTINGS_ID = 'weather';
export const WEATHER_SETTINGS_PATH = '/auth/profile/weather';
