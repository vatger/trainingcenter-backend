#######################
# Base Image
#######################
FROM alpine

WORKDIR /opt/trainingcenter_backend

ARG NODE_ENV=development

COPY package*.json ./

RUN apk update && apk add --update nodejs npm
RUN npm install --quiet --unsafe-perm --no-progress --no-audit --include=dev

COPY . .

# Init cron
ADD entry.sh /entry.sh
RUN chmod 755 /entry.sh

RUN npm run build

CMD ["sh", "/entry.sh"]