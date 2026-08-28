SELECT format('CREATE ROLE wb_platform LOGIN PASSWORD %L', :'pass') \gexec
ALTER DATABASE wb_platform OWNER TO wb_platform;
