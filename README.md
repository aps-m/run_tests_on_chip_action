# run_tests_on_chip_action

Запуск тестов на микроконтроллерах

## Параметры

### Вход

| Параметр        | Описание                                 | Тип    | Обязательный | Значение по умолчанию |
| --------------- | ---------------------------------------- | ------ | ------------ | --------------------- |
| gdb_target_host | Адрес и порт сервера отладки             | Строка | Да           | :3333                 |
| executable      | Исполняемый файл                         | Строка | Да           | -                     |
| timeout         | Таймаут ожидания в секундах              | Число  | Да           | 300                   |
| wait_for_msg    | Ожидаемый вывод сообщения для завершения | Строка | Да           | -                     |

## Пример использования

```yml
- name: Run on chip tests
  uses: aps-m/run_tests_on_chip_action@master
  with:
    timeout: 250
    gdb_target_host: 'localhost:3333'
    executable: 'Path/to/example.elf'
    wait_for_msg: 'Test completed'
```
