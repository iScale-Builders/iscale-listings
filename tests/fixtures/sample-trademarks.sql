-- Sample test data for local development and testing
-- Insert after running migrations

INSERT INTO trademarks (serial_number, registration_number, wordmark, wordmark_normalized, mark_drawing_type, status, status_code, filing_date, registration_date, owner_name, international_class)
VALUES
  ('88123456', '6234567', 'CAT DAD', 'cat dad', 'standard character', 'LIVE', '700', '2019-03-15', '2020-06-01', 'Pawsome Designs LLC', '025'),
  ('88234567', '6345678', 'DOG MOM', 'dog mom', 'standard character', 'LIVE', '700', '2019-05-20', '2020-08-15', 'Pet Love Inc.', '025'),
  ('88345678', '6456789', 'MOUNTAIN DEW', 'mountain dew', 'typeset', 'LIVE', '602', '2018-01-10', '2019-03-01', 'PepsiCo Inc.', '021'),
  ('88456789', '6567890', 'VINTAGE VIBES', 'vintage vibes', 'standard character', 'LIVE', '700', '2020-02-28', '2021-05-15', 'Retro Fashion Co.', '025'),
  ('88567890', NULL, 'ACE', 'ace', 'text', 'LIVE', '650', '2021-01-15', NULL, 'Ace Corp.', '025'),
  ('88678901', '6789012', 'WORLD''S BEST', 'worlds best', 'standard character', 'LIVE', '700', '2019-11-01', '2021-02-01', 'Generic Gifts LLC', '021'),
  ('88789012', '6890123', 'SUN', 'sun', 'text', 'LIVE', '700', '2017-06-15', '2018-09-01', 'Solar Brands Inc.', '025'),
  ('88890123', '6901234', 'FUNNY GIFT', 'funny gift', 'standard character', 'LIVE', '700', '2020-07-01', '2021-10-01', 'Laugh Factory LLC', '025'),
  ('88901234', NULL, 'RETRO', 'retro', 'text', 'LIVE', '650', '2021-03-10', NULL, 'Retro IP Holdings', '025'),
  ('89000001', '7000001', 'DEAD MARK', 'dead mark', 'standard character', 'DEAD', '300', '2015-01-01', '2016-06-01', 'Defunct Co.', '025'),
  ('89000002', '7000002', 'PHONE ARMOR', 'phone armor', 'standard character', 'LIVE', '700', '2020-09-01', '2021-12-01', 'TechShield Inc.', '009'),
  ('89000003', '7000003', 'COZY HOME', 'cozy home', 'standard character', 'LIVE', '700', '2019-04-15', '2020-07-01', 'HomeCraft LLC', '024'),
  ('89000004', '7000004', 'LEATHER LUXE', 'leather luxe', 'standard character', 'LIVE', '700', '2020-11-20', '2022-01-15', 'LuxBags Co.', '018'),
  ('89000005', '7000005', 'COMFORT ZONE', 'comfort zone', 'standard character', 'LIVE', '700', '2018-08-01', '2019-11-01', 'HomeStyle Inc.', '020');

-- Baseline sync metadata
INSERT INTO sync_metadata (sync_date, live_mark_count, marks_added, status)
VALUES (CURRENT_DATE, 13, 13, 'completed');
